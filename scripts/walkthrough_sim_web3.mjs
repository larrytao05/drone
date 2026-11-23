#!/usr/bin/env node
/**
 * Real isolated simulator bridge walkthrough for WEB-SIM-3:
 * Connects to the real Docker PX4 SIH simulation through the local bridge contract.
 * Validates:
 *   1. Initial state validation (phase=ready, cleanupCompleted=true)
 *   2. Route submission with benign synthetic local route (Zurich origin)
 *   3. Route identity verification (bridge retains executed route metadata & waypoints)
 *   4. Authoritative cleanup/ownership tracking (cleanupCompleted=false while active)
 *   5. Real geographic telemetry progress (lat, lon, northProgress, speed)
 *   6. Scenario blockage detection, hold command and hold confirmation
 *   7. Continued hold post-clearance
 *   8. Reload recovery verification (status poll without runId recovers active run and route snapshot)
 *   9. Explicit resume command and route motion resumption
 *   10. Teardown, container termination verification (docker ps) and cleanupCompleted=true
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createSimulationBridgeHandlers } from "../web/server/simulation-bridge.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runWalkthrough() {
  console.log("=== WEB-SIM-3 Real Isolated Simulator Bridge Walkthrough ===\n");

  const handlers = createSimulationBridgeHandlers({ dockerMode: true });
  let activeRunId = null;

  async function postCommand(body) {
    const req = new Request("http://localhost:3000/api/simulation", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const res = await handlers.post(req);
    return { status: res.status, data: await res.json() };
  }

  async function getStatus(runId) {
    const url = runId
      ? `http://localhost:3000/api/simulation?runId=${encodeURIComponent(runId)}`
      : "http://localhost:3000/api/simulation";
    const req = new Request(url, {
      method: "GET",
      headers: { origin: "http://localhost:3000" },
    });
    const res = await handlers.get(req);
    return { status: res.status, data: await res.json() };
  }

  try {
    // 1. Initial State
    console.log("[STEP 1] Checking initial bridge status...");
    const init = await getStatus();
    if (init.data.status.phase !== "ready") {
      throw new Error(`Expected ready phase, got ${init.data.status.phase}`);
    }
    if (init.data.status.cleanupCompleted !== true) {
      throw new Error(`Expected cleanupCompleted=true in initial ready phase, got ${init.data.status.cleanupCompleted}`);
    }
    console.log("  Initial status: phase=ready, runId=null, cleanupCompleted=true\n");

    // 2. Start Simulation with validated synthetic route
    console.log("[STEP 2] Submitting validated synthetic route to isolated simulator...");
    const fixtureData = JSON.parse(readFileSync("public/fixtures/synthetic-route.json", "utf-8"));
    const syntheticRoute = {
      name: fixtureData.draft.name,
      plannedAltitudeM: Number(fixtureData.draft.height),
      waypoints: fixtureData.draft.points.map((p) => ({
        latitudeDeg: Number(p.coordinate.latitude),
        longitudeDeg: Number(p.coordinate.longitude),
        altitudeM: Number(fixtureData.draft.height),
      })),
    };

    const start = await postCommand({ action: "start", route: syntheticRoute });
    if (start.status !== 200 || !start.data.ok) {
      throw new Error(`Start failed: ${JSON.stringify(start.data)}`);
    }
    activeRunId = start.data.status.runId;
    console.log(`  Simulation started: runId=${activeRunId}, phase=${start.data.status.phase}`);
    console.log(`  Authoritative ownership: cleanupCompleted=${start.data.status.cleanupCompleted}`);

    // Verify route identity preserved by bridge
    if (!start.data.status.route || start.data.status.route.name !== syntheticRoute.name) {
      throw new Error(`Route identity mismatch in start response: ${JSON.stringify(start.data.status.route)}`);
    }
    if (start.data.status.route.waypoints.length !== 3) {
      throw new Error(`Expected 3 waypoints in executed route, got ${start.data.status.route.waypoints.length}`);
    }
    console.log(`  Route identity confirmed: ${start.data.status.route.name} (${start.data.status.route.waypoints.length} waypoints)\n`);

    // 3. Monitor Route Motion & Geographic Telemetry
    console.log("[STEP 3] Monitoring real geographic telemetry and blockage hold...");
    const deadline = Date.now() + 65_000;
    let motionConfirmed = false;
    let holdConfirmed = false;
    let heldNorth = 0;
    let clearanceObserved = false;
    let lastEventCount = 0;
    let sampleCounter = 0;

    while (Date.now() < deadline) {
      await sleep(600);
      const snap = await getStatus(activeRunId);
      const status = snap.data.status;

      // Print newly arrived events
      if (status.events.length > lastEventCount) {
        for (let i = lastEventCount; i < status.events.length; i++) {
          console.log(`  [EVENT #${status.events[i].seq}] ${status.events[i].label}`);
        }
        lastEventCount = status.events.length;
      }

      if (status.telemetry) {
        const tel = status.telemetry;
        const pos = tel.position;
        const vel = tel.velocity;
        // Verify real coordinates: near Zurich (lat ~47.398, lon ~8.545)
        if (Math.abs(pos.lat - 47.398) > 0.05 || Math.abs(pos.lon - 8.545) > 0.05) {
          throw new Error(`Unrealistic telemetry coordinate: lat=${pos.lat}, lon=${pos.lon}`);
        }
        if (++sampleCounter % 4 === 0) {
          console.log(
            `  [TELEMETRY] lat=${pos.lat.toFixed(6)}, lon=${pos.lon.toFixed(6)}, alt=${pos.altM.toFixed(1)}m, N=${pos.northProgressM.toFixed(2)}m, speed=${vel.speedMs.toFixed(2)}m/s, fresh=${status.fresh}`
          );
        }
      }

      if (status.phase === "failed") {
        throw new Error(`Simulation failed: ${JSON.stringify(status.error)}`);
      }

      if (!motionConfirmed && status.events.some((e) => e.label.includes("Route motion confirmed"))) {
        motionConfirmed = true;
        console.log("  >> Route motion confirmed toward custom waypoints.");
      }

      if (status.holdConfirmed && status.phase === "holding") {
        holdConfirmed = true;
        heldNorth = status.telemetry?.position.northProgressM ?? 0;
        console.log(`  >> Hold confirmed at northProgress=${heldNorth.toFixed(2)}m.`);
        break;
      }
    }

    if (!holdConfirmed) {
      throw new Error("Timed out waiting for confirmed hold.");
    }

    // 4. Verify Continued Hold Post-Clearance
    console.log("\n[STEP 4] Observing blockage clearance and verifying continued hold...");
    const holdWaitDeadline = Date.now() + 15_000;
    while (Date.now() < holdWaitDeadline) {
      await sleep(600);
      const snap = await getStatus(activeRunId);
      const status = snap.data.status;

      if (status.events.length > lastEventCount) {
        for (let i = lastEventCount; i < status.events.length; i++) {
          console.log(`  [EVENT #${status.events[i].seq}] ${status.events[i].label}`);
        }
        lastEventCount = status.events.length;
      }

      if (!status.blocked && status.events.some((e) => e.label.includes("Blockage cleared"))) {
        clearanceObserved = true;
        console.log("  >> Blockage clearance observed.");
        // Check that vehicle remains in hold for at least 2.5s
        await sleep(2500);
        const holdCheck = await getStatus(activeRunId);
        if (holdCheck.data.status.phase !== "holding") {
          throw new Error(
            `Expected vehicle to remain holding after clearance, but phase is ${holdCheck.data.status.phase}`
          );
        }
        console.log("  >> Verified: Vehicle remains holding after clearance without automatic resume.");
        break;
      }
    }

    if (!clearanceObserved) {
      throw new Error("Timed out waiting for blockage clearance event.");
    }

    // 5. Verify Reload Recovery Contract
    console.log("\n[STEP 5] Verifying reload recovery contract (poll without runId)...");
    const reloadSnap = await getStatus(); // No runId supplied (simulates page reload / reconnect)
    const reloadStatus = reloadSnap.data.status;
    if (reloadStatus.runId !== activeRunId) {
      throw new Error(`Expected reload recovery to return active runId ${activeRunId}, got ${reloadStatus.runId}`);
    }
    if (reloadStatus.phase !== "holding") {
      throw new Error(`Expected recovered phase to be holding, got ${reloadStatus.phase}`);
    }
    if (reloadStatus.cleanupCompleted !== false) {
      throw new Error(`Expected cleanupCompleted=false during reload recovery of active run`);
    }
    if (!reloadStatus.route || reloadStatus.route.name !== syntheticRoute.name) {
      throw new Error(`Expected reload recovery to return executed route metadata`);
    }
    console.log("  >> Verified reload recovery: active run, executed route, and phase preserved.");

    // 6. Explicit Resume Command
    console.log("\n[STEP 6] Sending explicit resume command via bridge...");
    const resume = await postCommand({ action: "resume", runId: activeRunId });
    if (resume.status !== 200 || !resume.data.ok) {
      throw new Error(`Resume failed: ${JSON.stringify(resume.data)}`);
    }
    console.log("  >> Explicit resume command queued to runner.");

    // Wait for resumed motion
    const resumeDeadline = Date.now() + 20_000;
    let resumedMotionConfirmed = false;
    while (Date.now() < resumeDeadline) {
      await sleep(600);
      const snap = await getStatus(activeRunId);
      const status = snap.data.status;

      if (status.events.length > lastEventCount) {
        for (let i = lastEventCount; i < status.events.length; i++) {
          console.log(`  [EVENT #${status.events[i].seq}] ${status.events[i].label}`);
        }
        lastEventCount = status.events.length;
      }

      if (status.events.some((e) => e.label.includes("Route motion resumed"))) {
        resumedMotionConfirmed = true;
        console.log("  >> Route motion resumed confirmed by telemetry.");
        if (status.holdConfirmed || status.holdRequested) {
          throw new Error("Expected hold flags to be reset to false after resumed motion confirmed.");
        }
        console.log("  >> Verified: holdConfirmed and holdRequested reset to false.");
        break;
      }
    }

    if (!resumedMotionConfirmed) {
      throw new Error("Timed out waiting for resumed route motion.");
    }

    // 7. Teardown & Resource Cleanup
    console.log("\n[STEP 7] Teardown and authoritative cleanup verification...");
    const end = await postCommand({ action: "end", runId: activeRunId });
    if (end.status !== 200 || !end.data.ok) {
      throw new Error(`End failed: ${JSON.stringify(end.data)}`);
    }
    console.log(`  >> End response: phase=${end.data.status.phase}`);

    // Wait for cleanup completion
    const endDeadline = Date.now() + 25_000;
    let teardownConfirmed = false;
    while (Date.now() < endDeadline) {
      await sleep(500);
      const finalSnap = await getStatus(activeRunId);
      const finalStatus = finalSnap.data.status;
      if (finalStatus.cleanupCompleted === true) {
        teardownConfirmed = true;
        console.log("  >> Authoritative cleanup completed confirmed: cleanupCompleted=true");
        break;
      }
    }

    if (!teardownConfirmed) {
      throw new Error("Timed out waiting for cleanupCompleted=true after end command.");
    }

    activeRunId = null; // Mark successfully ended

    // Verify no orphaned docker containers
    const containers = execSync("docker ps -q --filter 'name=sim1_'").toString().trim();
    if (containers) {
      throw new Error(`Orphaned containers still running: ${containers}`);
    }
    console.log("  >> Verified: no leftover sim1 containers running in Docker.");

    console.log("\n=== WEB-SIM-3 WALKTHROUGH COMPLETED SUCCESSFULLY ===");
  } finally {
    if (activeRunId) {
      console.log(`\n[CLEANUP] Ensuring teardown for active run '${activeRunId}'...`);
      try {
        const cleanup = await handlers.session.end(activeRunId);
        if (!cleanup.ok) {
          console.error("  Could not confirm run cleanup:", cleanup.error);
        }
      } catch (err) {
        console.error("  Cleanup via session.end threw:", err);
      }
    }
  }
}

runWalkthrough().catch((err) => {
  console.error("\n[ERROR] Walkthrough failed:", err);
  process.exit(1);
});
