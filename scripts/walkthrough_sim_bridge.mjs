#!/usr/bin/env node
/**
 * Real isolated simulator bridge walkthrough:
 * Connects to the real Docker PX4 SIH simulation through the local bridge contract.
 * Observes:
 *   1. Initial state validation
 *   2. Startup & route motion
 *   3. Blockage injection & hold request
 *   4. Telemetry hold confirmation
 *   5. Clearance without resume
 *   6. Explicit resume command & resumed motion with hold-flag reset
 *   7. Clean teardown & container cleanup verification (guaranteed in finally)
 */

import { execSync } from "node:child_process";
import { createSimulationBridgeHandlers } from "../web/server/simulation-bridge.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runWalkthrough() {
  console.log("=== WEB-SIM-2 Real Isolated Simulator Bridge Walkthrough ===\n");

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
    console.log("  Initial status: phase=ready, runId=null\n");

    // 2. Start Simulation
    console.log("[STEP 2] Starting isolated simulator run...");
    const start = await postCommand({ action: "start" });
    if (start.status !== 200 || !start.data.ok) {
      throw new Error(`Start failed: ${JSON.stringify(start.data)}`);
    }
    activeRunId = start.data.status.runId;
    console.log(`  Simulation started: runId=${activeRunId}, phase=${start.data.status.phase}\n`);

    // 3. Monitor Route Motion
    console.log("[STEP 3] Monitoring telemetry for route motion and blockage...");
    const deadline = Date.now() + 60_000;
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
        // Deterministic telemetry cadence: log every 4th sample
        if (++sampleCounter % 4 === 0) {
          console.log(
            `  [TELEMETRY] N=${pos.northProgressM.toFixed(2)}m, speed=${vel.speedMs.toFixed(2)}m/s, age=${tel.sampleAgeMs}ms, fresh=${status.fresh}`
          );
        }
      }

      if (status.phase === "failed") {
        throw new Error(`Simulation failed: ${JSON.stringify(status.error)}`);
      }

      if (!motionConfirmed && status.events.some((e) => e.label.includes("Route motion confirmed"))) {
        motionConfirmed = true;
        console.log("  >> Route motion confirmed northward toward waypoint 1.");
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

    // 4. Verify Clearance Without Automatic Resume
    console.log("\n[STEP 4] Observing blockage clearance without automatic resume...");
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

    // 5. Send Explicit Resume
    console.log("\n[STEP 5] Sending explicit resume command via bridge...");
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
        // Verify hold flags were cleared on motion confirmation
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

    // 6. Teardown & Resource Cleanup
    console.log("\n[STEP 6] Teardown and resource cleanup...");
    const end = await postCommand({ action: "end", runId: activeRunId });
    if (end.status !== 200 || !end.data.ok) {
      throw new Error(`End failed: ${JSON.stringify(end.data)}`);
    }
    console.log(`  >> End response: phase=${end.data.status.phase}`);
    activeRunId = null; // Mark successfully ended

    // Verify no orphaned docker containers
    const containers = execSync("docker ps -q --filter 'name=sim1_'").toString().trim();
    if (containers) {
      throw new Error(`Orphaned containers still running: ${containers}`);
    }
    console.log("  >> Verified: no leftover sim1 containers running in Docker.");

    console.log("\n=== WALKTHROUGH COMPLETED SUCCESSFULLY ===");
  } finally {
    // Guaranteed teardown and container cleanup even on assertion failure
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
