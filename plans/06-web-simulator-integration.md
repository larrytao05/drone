# Web editor simulation integration

Add a dedicated Simulation tab alongside Edit. Start with a 2D map and a local software simulator. The long-term view is an external 3D scene where the operator can orbit the vehicle, route, and blockage.

The [clickable prototype](../prototypes/simulation-review.html) is the interaction reference. Reuse the map and draft state in the existing editor.

## Simulator baseline

SIM-1 through SIM-4 are complete per the project status update. They cover route execution and telemetry, deterministic hold, advisory and explicit resume, and a repeatable scenario with cleanup. Their completion no longer blocks web integration.

Before WEB-SIM-2, identify the completed runner revision and inspect its existing interface. Build the bridge around that interface and verify the browser-to-runner behavior in WEB-SIM-3. The three WEB-SIM-1 editor remediation passes and their independent reviews continue as planned.

The Next.js startup fix is tracked in [PR #33](https://github.com/larrytao05/drone/pull/33). Include it in the development baseline for browser verification if needed.

## Implementation tickets

### WEB-SIM-1 · Integrate the prototype with fixture data

Add Edit and Simulation tabs to MissionEditor. Show the route name, waypoint count, planned altitude, and **Start simulation** in the ready state. During a run, keep Edit readable and gate draft mutations at the editor boundary, including map changes, importing or loading, and applying assistant proposals. Show **Back to Simulation**. Place **End simulation** only in Simulation.

Reuse the map for vehicle position and blocked-segment overlays. Show phase, speed, altitude, last telemetry time, ordered events, and an advisory in the side panel. Label a stale map marker **Last known position**. Keep the block, clear, and telemetry toggles in fixture mode.

**Acceptance:** A browser walkthrough covers start, hold, blocked resume, stale telemetry, restored telemetry, explicit resume, and end. Changing tabs keeps the same run. Confirmed end restores editing.

### WEB-SIM-2 · Define the runner contract and local bridge

Capture a validated, immutable route snapshot at launch. Have a local runner own the simulator process and the run state. Start with a narrow Node-to-Python bridge and poll it from the editor. Give each run an ID and ordered status revisions. Report phase, position, velocity, sample time, blocked segment, and confirmed events. Expose start, status, resume, and end. Keep the assistant's output advisory.

**Acceptance:** One run can be active. Duplicate starts, wrong-run commands, and unsafe resume requests are rejected by the runner. Older status updates cannot replace newer UI state. An invalid route or unavailable runner produces a useful error. The bridge launches an isolated local simulator with bounded waits and cleanup.

### WEB-SIM-3 · Wire the live simulator and verify the full journey

Connect the controls and overlays to the bridge. Distinguish requested hold from confirmed hold, and track telemetry freshness separately from run phase. Keep **End simulation** available during a telemetry lapse. Retain the edit lock until teardown is confirmed. On reload, recover any active run before enabling editing or start.

First prove the bridge with the fixed simulator route. Then pass the launch snapshot from the planner and verify the executed route matches the map. Inject the blockage through the local test scenario.

**Acceptance:** A developer can reproduce a browser-to-simulator run in which telemetry confirms progress, a hold before the blockage, continued hold after clearing, motion after explicit resume, and process teardown after end. Verify stale telemetry disables resume both in the editor and at the runner. Document the actual simulator result separately from fixture-based browser checks. Run typecheck, tests, and lint after implementation.

## Later milestones

Build the external 3D view on the same run and telemetry contract. Add simulated obstacle perception behind the blockage signal. Replace the fixed advisory with a live model after the deterministic loop works end to end. Physical aircraft integration requires its own compatibility and validation work.
