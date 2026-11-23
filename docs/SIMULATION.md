# PX4 simulation smoke test

The smoke test runs a synthetic waypoint mission in an isolated PX4 software simulator. It checks northward route motion, autonomous hold before an injected blockage, continued hold after clearance, and motion after an explicit scripted resume.

## Scope & Constraints

- **Autonomous Simulation**: Connects programmatically to a local software simulator (PX4 SITL / SIH via MAVSDK).
- **Route Execution**: Uploads a fixed, benign synthetic waypoint mission and commands autonomous flight.
- **Telemetry Verification**: Streams live, timestamped position and speed telemetry from the autopilot and confirms sustained motion along the route.
- **Bounded Waits**: Uses strict timeouts for both simulator startup/readiness (30s default) and motion confirmation (20s default). Exits nonzero with structured error codes on timeout.
- **Hardware Isolation**: Docker mode confines PX4 and the client to a shared loopback-only network namespace. Native mode requires a trusted local simulator on a loopback address.
- **Out of Scope**: No UI, live LLM calls, obstacle perception, or physical aircraft.

---

## Architecture & Primary References

- **Simulator**: [PX4 Autopilot Software-in-the-Loop (SITL)](https://docs.px4.io/main/en/simulation/) running the built-in [Simulation In Hardware (SIH)](https://docs.px4.io/main/en/sim_sih/) lightweight physics engine.
- **Docker Container**: [`px4io/px4-sitl:latest`](https://hub.docker.com/r/px4io/px4-sitl) provides a headless, pre-compiled multi-arch (arm64/amd64) PX4 SIH image.
- **Protocol**: MAVLink v2 over UDP (standard offboard port `14540`).
- **Client Library**: [MAVSDK-Python / MAVSDK-gRPC](https://mavsdk.mavlink.io/main/en/python/) for async vehicle connection, telemetry streaming, and mission upload.

---

## Prerequisites

1. **Python 3.11+** (Apple Silicon or Intel macOS, Linux).
2. **MAVSDK for native mode** (Docker installs it in the client image):
   ```bash
   pip install -r requirements-sim.txt
   # or: pip install mavsdk-grpc
   ```
3. **Local Software Simulator**:
   - **Option A (Docker - Recommended)**: Docker Desktop running on your machine.
     The runner script can automatically launch and tear down the container when `--docker` is passed.
   - **Option B (Native PX4)**: If you have PX4-Autopilot built natively from source:
     ```bash
     make px4_sitl_sih sihsim_quadx
     ```

---

## Invocation

From the repository root, after starting Docker:

```bash
npm run test:sim
```

The command runs one full scenario. It prints separate events for the hold request, telemetry confirmation, clearance, continued hold, and explicit resume. Exit code zero requires both the scenario and container cleanup to succeed. PX4 and MAVSDK run in a shared network namespace without external connectivity or published ports.

### 1. Automated Run with Docker Container
The script builds a Python client image, then runs the client and PX4 in a shared Docker network namespace with networking disabled. MAVSDK connects to PX4 over loopback within that namespace. Both containers are removed when the run ends; building the client image requires network access. The motion check requires northward progress toward waypoint 1 and northward speed across three samples.

```bash
python3 scripts/sim1_run_route.py --docker
```

To inject a blockage after sustained route motion and verify that PX4 pauses before the blocked boundary:

```bash
python3 scripts/sim1_run_route.py --docker --scenario hold
```

The command reports the injected blockage, the pause request, and the stop confirmed by telemetry as separate events.

Use `--scenario full` to also print the fixed advisory, check continued hold for two seconds after clearance, and verify motion after the script explicitly resumes. The continued-hold check allows up to 0.75 m/s and 1 m of northward drift.

### 2. Run Against Existing Local Simulator
If PX4 SITL/SIH is already running locally on port 14540:

```bash
python3 scripts/sim1_run_route.py
```

### 3. Custom Bounded Timeouts or Port
```bash
python3 scripts/sim1_run_route.py --address udpin://127.0.0.1:14540 --startup-timeout 30.0 --motion-timeout 25.0
```

---

## Exit Codes

| Code | Label | Description |
|---|---|---|
| `0` | `SUCCESS` | The selected scenario passed and any owned containers were removed. |
| `1` | `SIMULATOR_ERROR` | Command, Docker setup, or cleanup failure, or an interrupted run. |
| `2` | `STARTUP_TIMEOUT` | Simulator failed to connect or preflight checks did not pass within timeout. |
| `3` | `MOTION_TIMEOUT` | A motion, hold, or route-boundary assertion failed. |
| `4` | `SAFETY_VIOLATION` | Non-local or hardware address provided (strictly prohibited). |
| `5` | `PREREQUISITE_MISSING` | Required Python packages (`mavsdk-grpc`) or tools missing. |

---

## Verification & Testing

Unit tests cover address validation, route motion, hold and resume behavior, and cleanup:

```bash
python3 -m unittest tests/test_sim1_run_route.py
```
