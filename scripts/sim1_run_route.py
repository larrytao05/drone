#!/usr/bin/env python3
"""
SIM-1: Autonomous Route Execution and Telemetry Verification in Software Simulation.

This script executes a fixed, benign synthetic waypoint route against a local software
simulator (PX4 SITL / SIH with MAVSDK). It reads timestamped position and speed telemetry
and confirms physical motion along the route.

Safety Guard:
    Docker mode isolates the simulator and client in a loopback-only namespace.
    Any connection to real hardware, serial ports, or external networks is forbidden
    and rejected immediately.

Bound Waits & Exit Codes:
    0: Success - Route executed, timestamped telemetry read, and motion confirmed.
    1: Simulator error or unexpected failure.
    2: Startup timeout - Simulator failed to start or preflight checks not ready within bounds.
    3: Motion timeout - Motion along route could not be confirmed within bounds.
    4: Safety violation - Attempted connection to non-local address or real hardware.
    5: Prerequisite missing - mavsdk-grpc or mavsdk not installed.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, List, Optional

# Ensure repo root and script directory are on sys.path
_script_dir = Path(__file__).resolve().parent
_repo_root = _script_dir.parent
for _p in (str(_repo_root), str(_script_dir)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# Re-export shared symbols for backwards compatibility and test imports
try:
    from scripts.sim1_shared import (
        ALLOWED_ADDRESS_PATTERN,
        HARDWARE_PATTERNS,
        MAVSDK_AVAILABLE,
        MissionItem,
        MissionPlan,
        MotionDetector,
        MotionTimeoutError,
        PrerequisiteMissingError,
        SafetyViolationError,
        SimulatorError,
        StartupTimeoutError,
        System,
        calculate_displacement,
        cleanup_drone,
        emit_interactive,
        generate_synthetic_route,
        read_sample,
        remove_simulator_containers,
        route_sample,
        sim1_startup,
        validate_safe_address,
    )
    from scripts.sim1_interactive import run_sim1_interactive
except ImportError:
    from sim1_shared import (
        ALLOWED_ADDRESS_PATTERN,
        HARDWARE_PATTERNS,
        MAVSDK_AVAILABLE,
        MissionItem,
        MissionPlan,
        MotionDetector,
        MotionTimeoutError,
        PrerequisiteMissingError,
        SafetyViolationError,
        SimulatorError,
        StartupTimeoutError,
        System,
        calculate_displacement,
        cleanup_drone,
        emit_interactive,
        generate_synthetic_route,
        read_sample,
        remove_simulator_containers,
        route_sample,
        sim1_startup,
        validate_safe_address,
    )
    from sim1_interactive import run_sim1_interactive


async def verify_blocked_hold(drone: Any, origin: Any, initial_progress: float) -> float:
    """Smoke test helper: Inject blockage and verify vehicle holds position within bounds."""
    boundary = 20.0
    if initial_progress >= boundary:
        raise MotionTimeoutError("The simulator reached the blocked segment before injection.")
    print(f"[BLOCKAGE] Injected at {initial_progress:.2f} m north. Blocked segment starts at {boundary:.1f} m.")
    print("[HOLD] Requesting mission pause.")
    deadline = time.monotonic() + 12

    async def pause_mission() -> None:
        async with asyncio.timeout(5):
            await drone.mission.pause_mission()

    pause = asyncio.create_task(pause_mission())
    stopped_since = None
    try:
        while time.monotonic() < deadline:
            north, speed, _ = await route_sample(drone, origin, deadline)
            if north >= boundary:
                raise MotionTimeoutError(f"Simulator entered blocked segment at {north:.2f} m.")
            if pause.done():
                await pause
                now = time.monotonic()
                if speed > 0.5:
                    stopped_since = None
                elif stopped_since is None:
                    stopped_since = now
                elif now - stopped_since >= 1.0:
                    print(f"[HOLD] Confirmed by telemetry at {north:.2f} m north and {speed:.2f} m/s.")
                    return north
            await asyncio.sleep(0.2)
        raise MotionTimeoutError("Hold was not confirmed within 12 seconds.")
    finally:
        if not pause.done():
            pause.cancel()
        await asyncio.gather(pause, return_exceptions=True)


async def resume_if_clear(drone: Any, origin: Any, blocked: asyncio.Event) -> float:
    """Smoke test helper: Attempt explicit resume only when blockage is cleared."""
    if blocked.is_set():
        raise SimulatorError("Resume rejected: segment is blocked.")
    north, speed, _ = await route_sample(drone, origin, time.monotonic() + 2)
    if speed > 0.75:
        raise SimulatorError("Resume rejected: telemetry does not show a hold.")
    if blocked.is_set():
        raise SimulatorError("Resume rejected: segment is blocked.")
    print("[RESUME] Explicit resume requested.")
    try:
        await asyncio.wait_for(drone.mission.start_mission(), 5)
    except asyncio.TimeoutError as exc:
        raise SimulatorError("Resume command timed out.") from exc
    return north


async def verify_clear_and_resume(drone: Any, origin: Any, held_north: float, blocked: asyncio.Event) -> None:
    """Smoke test helper: Verify continued hold post-clearance, then verify motion post-resume."""
    print("[ADVISORY] Stay in hold until the segment clears and the operator explicitly resumes.")
    blocked.clear()
    print("[BLOCKAGE] Cleared; hold remains active.")
    observe_until = time.monotonic() + 2
    while True:
        north, speed, _ = await route_sample(drone, origin, observe_until + 1)
        if speed > 0.75 or abs(north - held_north) > 1.0:
            raise MotionTimeoutError(
                f"Simulator moved after clearance without an explicit resume "
                f"(speed {speed:.2f} m/s, northward drift {north - held_north:+.2f} m)."
            )
        if time.monotonic() >= observe_until:
            break
        await asyncio.sleep(0.2)
    print("[HOLD] Telemetry confirmed continued hold for two seconds after clearance.")

    resume_north = await resume_if_clear(drone, origin, blocked)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        north, _, north_speed = await route_sample(drone, origin, deadline)
        if north >= resume_north + 2.0 and north_speed >= 0.5:
            print(f"[RESUME] Telemetry confirmed route motion at {north:.2f} m north and {north_speed:.2f} m/s northward.")
            return
    raise MotionTimeoutError("Resumed route motion was not confirmed within 10 seconds.")


async def run_sim1(
    address: str,
    startup_timeout: float = 30.0,
    motion_timeout: float = 20.0,
    manage_docker: bool = False,
    docker_image: str = "px4io/px4-sitl:latest",
    route_alt: float = 10.0,
    route_speed: float = 4.0,
    scenario: str = "route",
) -> bool:
    """
    Execute the SIM-1 smoke test workflow:
      1. Preflight startup via sim1_startup.
      2. Stream telemetry and verify confirmed route motion.
      3. Optionally execute hold and clearance scenarios.
      4. Guarantee cleanup of MAVSDK connections.
    """
    validate_safe_address(address)
    if manage_docker:
        raise SimulatorError("Use the --docker CLI option for isolated simulation.")

    drone = None
    try:
        def log_event(msg: str) -> None:
            print(f"[STARTUP] {msg}")

        drone, initial_pos, items, detector = await sim1_startup(
            address=address,
            startup_timeout=startup_timeout,
            route_alt=route_alt,
            route_speed=route_speed,
            event_callback=log_event,
        )

        flight_start = time.monotonic()
        print(f"\n[FLIGHT] Monitoring route execution and telemetry (timeout: {motion_timeout}s)...")
        print(
            f"{'Timestamp':<28} {'Elapsed':<8} {'Lat':<12} {'Lon':<12} "
            f"{'Alt(m)':<8} {'Speed(m/s)':<10} {'North(m)':<12} {'Status'}"
        )
        print("-" * 105)

        motion_confirmed = False
        sample = None
        while time.monotonic() - flight_start < motion_timeout:
            await asyncio.sleep(0.5)
            try:
                pos = await read_sample(drone.telemetry.position(), motion_timeout - (time.monotonic() - flight_start))
                vel = await read_sample(drone.telemetry.velocity_ned(), motion_timeout - (time.monotonic() - flight_start))
            except (asyncio.TimeoutError, StopAsyncIteration) as exc:
                raise MotionTimeoutError("Position or velocity telemetry became unavailable.") from exc

            speed_m_s = vel.north_m_s
            elapsed = time.monotonic() - flight_start
            iso_now = datetime.datetime.now(datetime.timezone.utc).isoformat()

            sample = detector.record_sample(
                lat=pos.latitude_deg,
                lon=pos.longitude_deg,
                rel_alt=pos.relative_altitude_m,
                speed_m_s=speed_m_s,
                elapsed_s=elapsed,
                iso_timestamp=iso_now,
            )

            status_flag = "MOVING" if sample["is_moving"] else "STATIONARY"
            print(
                f"{sample['timestamp']:<28} "
                f"+{sample['elapsed_s']:<7.1f}s "
                f"{sample['lat']:<12.6f} "
                f"{sample['lon']:<12.6f} "
                f"{sample['alt_m']:<7.2f}m "
                f"{sample['speed_m_s']:<7.2f}m/s "
                f"{sample['north_progress_m']:<10.2f}m "
                f"{status_flag}"
            )

            if sample["confirmed"]:
                motion_confirmed = True
                break

        print("-" * 105)

        if not motion_confirmed or sample is None:
            raise MotionTimeoutError(
                f"Motion along route could not be confirmed within bounded timeout of {motion_timeout}s. "
                f"Max speed observed: {detector.max_speed_observed:.2f} m/s, "
                f"Max displacement: {detector.max_displacement_observed:.2f} m."
            )

        print("\n[VERIFICATION SUCCESS]")
        print(f"  - Route Waypoints: {len(items)} synthetic points")
        print(f"  - Confirmation Time: {sample['elapsed_s']:.1f}s after mission start")
        print(f"  - Northward progress toward waypoint 1: {sample['north_progress_m']:.2f} meters (threshold: >=2.0m)")
        print(f"  - Current Northward Speed: {sample['speed_m_s']:.2f} m/s (threshold: >=0.5m/s)")
        print(f"  - Peak Northward Speed Observed: {detector.max_speed_observed:.2f} m/s")
        print("  - Telemetry Integrity: Timestamped position and speed stream verified.")
        print("SIM-1 Acceptance Criteria Satisfied.")

        if scenario in ("hold", "full"):
            blocked = asyncio.Event()
            blocked.set()
            held_north = await verify_blocked_hold(drone, initial_pos, sample["north_progress_m"])
            if scenario == "full":
                await verify_clear_and_resume(drone, initial_pos, held_north, blocked)
        return True
    finally:
        await cleanup_drone(drone)


def run_isolated_docker(args: Any) -> int:
    """Launch isolated Docker client and PX4 containers, and dispatch session."""
    if args.address != "udpin://127.0.0.1:14540":
        raise SafetyViolationError("Docker mode requires udpin://127.0.0.1:14540.")
    if not shutil.which("docker"):
        raise PrerequisiteMissingError("Docker CLI not found on PATH.")

    if getattr(args, "run_id", None):
        clean_run_id = str(args.run_id).strip()
        if not re.match(r"^sim[a-zA-Z0-9_]+$", clean_run_id):
            raise SafetyViolationError(f"Invalid run_id format for isolated containers: {clean_run_id}")
        name = f"sim1_{clean_run_id}"
    else:
        name = f"sim1_{os.getpid()}_{time.time_ns()}"
    client = f"{name}_client"
    px4 = f"{name}_px4"
    root = Path(__file__).resolve().parent.parent
    image = "sim1-python-local"
    stage = "building the simulator client image"
    status = 1
    cleaned = False
    try:
        subprocess.run(["docker", "build", "-t", image, "-f", str(root / "scripts/sim1.Dockerfile"), str(root)], check=True, timeout=300)
        stage = "starting the isolated client"
        subprocess.run(["docker", "run", "-d", "--rm", "--name", client, "--network", "none", "-v", f"{root / 'scripts'}:/work/scripts:ro", image, "sleep", "infinity"], check=True, stdout=subprocess.DEVNULL, timeout=30)
        stage = "starting PX4 in the isolated namespace"
        subprocess.run(["docker", "run", "-dt", "--rm", "--name", px4, "--network", f"container:{client}", args.docker_image], check=True, stdout=subprocess.DEVNULL, timeout=30)

        if getattr(args, "interactive", False):
            emit_interactive("containers", {"containers": [px4, client]})
            stage = "running the interactive simulator session"
            cmd = [
                "docker", "exec", "-i", client, "python", "-u", "/work/scripts/sim1_run_route.py",
                "--interactive",
                "--address", args.address,
                "--startup-timeout", str(args.startup_timeout),
                "--motion-timeout", str(args.motion_timeout),
                "--alt", str(args.alt),
                "--speed", str(args.speed),
            ]
            if getattr(args, "run_id", None):
                cmd.extend(["--run-id", args.run_id])
            if getattr(args, "max_runtime", None):
                cmd.extend(["--max-runtime", str(args.max_runtime)])
            if getattr(args, "route_json", None):
                cmd.extend(["--route-json", args.route_json])
            proc = subprocess.Popen(cmd, stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr)
            status = proc.wait()
        else:
            stage = "running the simulator scenario"
            status = subprocess.run([
                "docker", "exec", client, "python", "-u", "/work/scripts/sim1_run_route.py",
                "--address", args.address, "--startup-timeout", str(args.startup_timeout),
                "--motion-timeout", str(args.motion_timeout), "--alt", str(args.alt), "--speed", str(args.speed),
                "--scenario", args.scenario,
            ], timeout=4 * args.startup_timeout + args.motion_timeout + 45).returncode
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        if getattr(args, "interactive", False):
            emit_interactive("error", {"code": "SIMULATOR_ERROR", "message": f"Docker failed while {stage}: {exc}"})
            emit_interactive("phase", {"phase": "failed"})
        raise SimulatorError(f"Docker failed while {stage}: {exc}") from exc
    finally:
        cleaned = remove_simulator_containers((px4, client))
        if getattr(args, "interactive", False):
            emit_interactive("cleanup", {"success": cleaned, "containers": [px4, client]})

    if status:
        if not getattr(args, "interactive", False):
            print(f"[FAIL] Simulator scenario exited with status {status}.", file=sys.stderr)
        return status if status > 0 else 1
    if not cleaned:
        return 1
    if not getattr(args, "interactive", False) and args.scenario == "full":
        print("[PASS] Route motion, blocked hold, continued hold after clearance, and explicit resume verified.")
    return 0


def parse_args(args: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="SIM-1: Run a synthetic waypoint route in local simulation and verify motion via telemetry."
    )
    parser.add_argument(
        "--address",
        default=os.environ.get("SIM_SYSTEM_ADDRESS", "udpin://127.0.0.1:14540"),
        help="Local MAVLink simulation address (default: udpin://127.0.0.1:14540). Must be localhost/loopback.",
    )
    parser.add_argument(
        "--startup-timeout",
        type=float,
        default=float(os.environ.get("SIM_STARTUP_TIMEOUT", "30.0")),
        help="Maximum seconds to wait for simulator startup and preflight health (default: 30.0s).",
    )
    parser.add_argument(
        "--motion-timeout",
        type=float,
        default=float(os.environ.get("SIM_MOTION_TIMEOUT", "20.0")),
        help="Maximum seconds to observe sustained motion along route (default: 20.0s).",
    )
    parser.add_argument(
        "--max-runtime",
        type=float,
        default=float(os.environ.get("SIM_MAX_RUNTIME", "600.0")),
        help="Maximum bounded lifetime for interactive session in seconds (default: 600.0s).",
    )
    parser.add_argument(
        "--docker",
        action="store_true",
        default=os.environ.get("SIM_DOCKER", "0") in ("1", "true", "True"),
        help="Automatically launch and manage local PX4 SITL/SIH Docker container (px4io/px4-sitl:latest).",
    )
    parser.add_argument(
        "--docker-image",
        default="px4io/px4-sitl:latest",
        help="Docker image for local PX4 simulation (default: px4io/px4-sitl:latest).",
    )
    parser.add_argument(
        "--alt",
        type=float,
        default=10.0,
        help="Relative route altitude in meters (default: 10.0m).",
    )
    parser.add_argument(
        "--speed",
        type=float,
        default=4.0,
        help="Route flight speed in m/s (default: 4.0m/s).",
    )
    parser.add_argument("--scenario", choices=("route", "hold", "full"), default="route")
    parser.add_argument(
        "--interactive",
        action="store_true",
        default=False,
        help="Run as interactive JSON-lines session for the local simulator bridge.",
    )
    parser.add_argument(
        "--run-id",
        default=None,
        help="Optional run identifier for tracking in interactive mode.",
    )
    parser.add_argument(
        "--route-json",
        default=None,
        help="Optional JSON string of route waypoints to execute.",
    )
    parsed = parser.parse_args(args)
    for name in ("startup_timeout", "motion_timeout", "max_runtime", "alt", "speed"):
        value = getattr(parsed, name)
        if not math.isfinite(value) or value <= 0:
            parser.error(f"--{name.replace('_', '-')} must be finite and positive")
    return parsed


def main() -> int:
    args = parse_args()

    # Register OS signals for graceful teardown
    def sig_handler(sig: int, frame: Any) -> None:
        print(f"\n[ABORT] Received signal {sig}. Exiting...")
        sys.exit(1)

    signal.signal(signal.SIGINT, sig_handler)
    signal.signal(signal.SIGTERM, sig_handler)

    def handle_error(code: str, msg: str, exit_code: int) -> int:
        if args.interactive:
            emit_interactive("error", {"code": code, "message": msg})
            emit_interactive("phase", {"phase": "failed"})
        print(f"\nERROR [{code}]: {msg}", file=sys.stderr)
        return exit_code

    try:
        if args.docker:
            return run_isolated_docker(args)
        if args.interactive:
            custom_waypoints = None
            if args.route_json:
                try:
                    custom_waypoints = json.loads(args.route_json)
                except Exception as exc:
                    return handle_error("INVALID_REQUEST", f"Failed to parse --route-json: {exc}", 1)

            success = asyncio.run(
                run_sim1_interactive(
                    address=args.address,
                    startup_timeout=args.startup_timeout,
                    motion_timeout=args.motion_timeout,
                    route_alt=args.alt,
                    route_speed=args.speed,
                    run_id=args.run_id,
                    max_runtime=args.max_runtime,
                    custom_waypoints=custom_waypoints,
                )
            )
            return 0 if success else 1
        success = asyncio.run(
            run_sim1(
                address=args.address,
                startup_timeout=args.startup_timeout,
                motion_timeout=args.motion_timeout,
                manage_docker=args.docker,
                docker_image=args.docker_image,
                route_alt=args.alt,
                route_speed=args.speed,
                scenario=args.scenario,
            )
        )
        return 0 if success else 1
    except SafetyViolationError as err:
        return handle_error("SAFETY_VIOLATION", str(err), 4)
    except PrerequisiteMissingError as err:
        return handle_error("PREREQUISITE_MISSING", str(err), 5)
    except StartupTimeoutError as err:
        return handle_error("STARTUP_TIMEOUT", str(err), 2)
    except MotionTimeoutError as err:
        return handle_error("MOTION_TIMEOUT", str(err), 3)
    except SimulatorError as err:
        return handle_error("SIMULATOR_ERROR", str(err), 1)
    except Exception as err:
        return handle_error("SIMULATOR_ERROR", str(err), 1)


if __name__ == "__main__":
    sys.exit(main())
