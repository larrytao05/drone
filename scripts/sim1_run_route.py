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
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from contextlib import aclosing
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Try importing MAVSDK (supporting either mavsdk_grpc or legacy mavsdk)
MAVSDK_AVAILABLE = False
System: Any = None
MissionItem: Any = None
MissionPlan: Any = None

try:
    from mavsdk_grpc import System
    from mavsdk_grpc.mission import MissionItem, MissionPlan
    MAVSDK_AVAILABLE = True
except ImportError:
    try:
        from mavsdk import System
        from mavsdk.mission import MissionItem, MissionPlan
        MAVSDK_AVAILABLE = True
    except ImportError:
        pass


class SafetyViolationError(Exception):
    """Raised when an unsafe connection address or real hardware is specified."""
    pass


class PrerequisiteMissingError(Exception):
    """Raised when necessary simulation packages or dependencies are missing."""
    pass


class StartupTimeoutError(Exception):
    """Raised when simulator startup or preflight readiness exceeds the bounded timeout."""
    pass


class MotionTimeoutError(Exception):
    """Raised when drone motion along the route cannot be confirmed within the bounded timeout."""
    pass


class SimulatorError(Exception):
    """Raised when a MAVLink/MAVSDK simulator command fails."""
    pass


# Allowed address regex: strictly local UDP/TCP addresses
ALLOWED_ADDRESS_PATTERN = re.compile(
    r"^(udpin|udpout|udp|tcp)://(localhost|127\.0\.0\.1):([0-9]{1,5})$",
    re.IGNORECASE,
)

HARDWARE_PATTERNS = [
    re.compile(r"/dev/(tty|cu\.|serial)", re.IGNORECASE),
    re.compile(r"COM\d+", re.IGNORECASE),
    re.compile(r"serial://", re.IGNORECASE),
    re.compile(r"usb", re.IGNORECASE),
    re.compile(r"bluetooth", re.IGNORECASE),
]


def validate_safe_address(address: str) -> None:
    """
    Verify that the target address is strictly an isolated local software simulation endpoint.
    Refuses any hardware interfaces (serial, USB) or external IP addresses.
    """
    if not address or not isinstance(address, str):
        raise SafetyViolationError("Connection address must be a non-empty string.")

    # Check for prohibited hardware patterns
    for pattern in HARDWARE_PATTERNS:
        if pattern.search(address):
            raise SafetyViolationError(
                f"Hardware connection forbidden: Address '{address}' appears to reference "
                "physical hardware or serial devices. SIM-1 is strictly isolated to software simulation."
            )

    # Check allowed local formats
    clean_address = address.strip()
    match = ALLOWED_ADDRESS_PATTERN.fullmatch(clean_address)
    if not match or not 1 <= int(match[3]) <= 65535:
        raise SafetyViolationError(
            f"Unsafe connection address: '{address}'. Only local simulation loopback addresses "
            "(e.g., 'udpin://127.0.0.1:14540', 'udp://127.0.0.1:14540') are permitted."
        )


def calculate_displacement(
    lat1: float, lon1: float, alt1: float,
    lat2: float, lon2: float, alt2: float
) -> Tuple[float, float, float, float]:
    """
    Calculate (d_north, d_east, d_up, total_3d_distance) in meters
    between two local geographic points using equirectangular projection.
    """
    meters_per_deg_lat = 111320.0
    meters_per_deg_lon = 111320.0 * math.cos(math.radians(lat1))

    d_north = (lat2 - lat1) * meters_per_deg_lat
    d_east = (lon2 - lon1) * meters_per_deg_lon
    d_up = alt2 - alt1
    dist_3d = math.hypot(d_north, d_east, d_up)
    return d_north, d_east, d_up, dist_3d


def generate_synthetic_route(
    home_lat: float, home_lon: float, alt_m: float = 10.0, speed_m_s: float = 4.0
) -> List[Any]:
    """
    Construct a fixed, benign synthetic waypoint route relative to home position.

    The route forms a benign triangular pattern:
      - WP1: North offset (+0.000300 deg ~33m)
      - WP2: North-East offset (+0.000300 deg N, +0.000400 deg E ~30m)
      - WP3: East offset (+0.000000 deg N, +0.000400 deg E ~30m)
    Altitude: 10m relative (safe ground clearance in SIH).
    Speed: 4 m/s (moderate, safe simulation speed).
    """
    offsets = [
        (0.000300, 0.000000),
        (0.000300, 0.000400),
        (0.000000, 0.000400),
    ]

    items = []
    for d_lat, d_lon in offsets:
        wp_lat = home_lat + d_lat
        wp_lon = home_lon + d_lon
        if MissionItem is not None:
            items.append(
                MissionItem(
                    latitude_deg=wp_lat,
                    longitude_deg=wp_lon,
                    relative_altitude_m=alt_m,
                    speed_m_s=speed_m_s,
                    is_fly_through=True,
                    gimbal_pitch_deg=float("nan"),
                    gimbal_yaw_deg=float("nan"),
                    camera_action=MissionItem.CameraAction.NONE,
                    loiter_time_s=float("nan"),
                    camera_photo_interval_s=float("nan"),
                    acceptance_radius_m=2.0,
                    yaw_deg=float("nan"),
                    camera_photo_distance_m=float("nan"),
                    vehicle_action=MissionItem.VehicleAction.NONE,
                )
            )
        else:
            # Fallback dict for testing when mavsdk is mocked
            items.append({
                "latitude_deg": wp_lat,
                "longitude_deg": wp_lon,
                "relative_altitude_m": alt_m,
                "speed_m_s": speed_m_s,
            })
    return items


class MotionDetector:
    """
    Tracks and validates movement along route from live telemetry.
    Confirms motion when minimum displacement and speed are observed
    consistently across multiple samples.
    """

    def __init__(
        self,
        home_lat: float,
        home_lon: float,
        home_alt: float,
        min_displacement_m: float = 2.0,
        min_speed_m_s: float = 0.5,
        required_samples: int = 3,
    ):
        self.home_lat = home_lat
        self.home_lon = home_lon
        self.home_alt = home_alt
        self.min_displacement_m = min_displacement_m
        self.min_speed_m_s = min_speed_m_s
        self.required_samples = required_samples

        self.consecutive_moving_samples = 0
        self.max_speed_observed = 0.0
        self.max_displacement_observed = 0.0
        self.is_confirmed = False
        self.history: List[Dict[str, Any]] = []

    def record_sample(
        self,
        lat: float,
        lon: float,
        rel_alt: float,
        speed_m_s: float,
        elapsed_s: float,
        iso_timestamp: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Record and evaluate a telemetry sample."""
        if iso_timestamp is None:
            iso_timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()

        north_progress, _, _, _ = calculate_displacement(
            self.home_lat, self.home_lon, self.home_alt,
            lat, lon, rel_alt
        )

        if speed_m_s > self.max_speed_observed:
            self.max_speed_observed = speed_m_s
        if north_progress > self.max_displacement_observed:
            self.max_displacement_observed = north_progress

        is_moving_sample = (north_progress >= self.min_displacement_m and speed_m_s >= self.min_speed_m_s)
        if is_moving_sample:
            self.consecutive_moving_samples += 1
        else:
            # Reset consecutive count if stationary
            self.consecutive_moving_samples = 0

        if self.consecutive_moving_samples >= self.required_samples:
            self.is_confirmed = True

        sample_data = {
            "timestamp": iso_timestamp,
            "elapsed_s": elapsed_s,
            "lat": lat,
            "lon": lon,
            "alt_m": rel_alt,
            "speed_m_s": speed_m_s,
            "north_progress_m": north_progress,
            "is_moving": is_moving_sample,
            "confirmed": self.is_confirmed,
        }
        self.history.append(sample_data)
        return sample_data


def remove_simulator_containers(containers: tuple[str, str]) -> bool:
    interrupted = False

    def defer_interrupt(sig: int, _frame: Any) -> None:
        nonlocal interrupted
        interrupted = True
        print(f"[ABORT] Received signal {sig}; finishing simulator cleanup.", file=sys.stderr)

    handlers = {sig: signal.signal(sig, defer_interrupt) for sig in (signal.SIGINT, signal.SIGTERM)}
    failures = []
    try:
        for container in containers:
            try:
                removed = subprocess.run(["docker", "rm", "-f", container], capture_output=True, text=True, timeout=10)
                if removed.returncode and "No such container" not in removed.stderr:
                    failures.append(container)
            except (OSError, subprocess.TimeoutExpired):
                failures.append(container)
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)

    if failures:
        print(f"[CLEANUP] Could not remove: {', '.join(failures)}.", file=sys.stderr)
    else:
        print("[CLEANUP] Simulator containers removed.")
    return not interrupted and not failures


def run_isolated_docker(args: Any) -> int:
    if args.address != "udpin://127.0.0.1:14540":
        raise SafetyViolationError("Docker mode requires udpin://127.0.0.1:14540.")
    if not shutil.which("docker"):
        raise PrerequisiteMissingError("Docker CLI not found on PATH.")

    name = f"sim1_{os.getpid()}_{time.time_ns()}"
    client = f"{name}_client"
    px4 = f"{name}_px4"
    root = Path(__file__).resolve().parent.parent
    image = "sim1-python-local"
    stage = "building the simulator client image"
    try:
        subprocess.run(["docker", "build", "-t", image, "-f", str(root / "scripts/sim1.Dockerfile"), str(root)], check=True, timeout=300)
        stage = "starting the isolated client"
        subprocess.run(["docker", "run", "-d", "--rm", "--name", client, "--network", "none", "-v", f"{root / 'scripts'}:/work/scripts:ro", image, "sleep", "infinity"], check=True, stdout=subprocess.DEVNULL, timeout=30)
        stage = "starting PX4 in the isolated namespace"
        subprocess.run(["docker", "run", "-dt", "--rm", "--name", px4, "--network", f"container:{client}", args.docker_image], check=True, stdout=subprocess.DEVNULL, timeout=30)
        stage = "running the simulator scenario"
        status = subprocess.run([
            "docker", "exec", client, "python", "-u", "/work/scripts/sim1_run_route.py",
            "--address", args.address, "--startup-timeout", str(args.startup_timeout),
            "--motion-timeout", str(args.motion_timeout), "--alt", str(args.alt), "--speed", str(args.speed),
            "--scenario", args.scenario,
        ], timeout=4 * args.startup_timeout + args.motion_timeout + 45).returncode
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        raise SimulatorError(f"Docker failed while {stage}: {exc}") from exc
    finally:
        cleaned = remove_simulator_containers((px4, client))

    if status:
        print(f"[FAIL] Simulator scenario exited with status {status}.", file=sys.stderr)
        return status if status > 0 else 1
    if not cleaned:
        return 1
    if args.scenario == "full":
        print("[PASS] Route motion, blocked hold, continued hold after clearance, and explicit resume verified.")
    return 0


async def read_sample(stream: Any, timeout: float) -> Any:
    async with aclosing(stream):
        return await asyncio.wait_for(anext(stream), timeout)


async def route_sample(drone: Any, origin: Any, deadline: float) -> tuple[float, float, float]:
    try:
        pos = await read_sample(drone.telemetry.position(), deadline - time.monotonic())
        vel = await read_sample(drone.telemetry.velocity_ned(), deadline - time.monotonic())
    except (asyncio.TimeoutError, StopAsyncIteration) as exc:
        raise MotionTimeoutError("Position or velocity telemetry became unavailable.") from exc
    north, _, _, _ = calculate_displacement(
        origin.latitude_deg, origin.longitude_deg, origin.relative_altitude_m,
        pos.latitude_deg, pos.longitude_deg, pos.relative_altitude_m,
    )
    speed = math.hypot(vel.north_m_s, vel.east_m_s, vel.down_m_s)
    if not all(math.isfinite(value) for value in (north, speed, vel.north_m_s)):
        raise MotionTimeoutError("Position or velocity telemetry was invalid.")
    return north, speed, vel.north_m_s


async def verify_blocked_hold(drone: Any, origin: Any, initial_progress: float) -> float:
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
    Execute the SIM-1 workflow:
      1. Validate safety of the target address.
      2. Optionally launch local PX4 SIH Docker simulator.
      3. Connect via MAVSDK and bound startup wait.
      4. Verify preflight health (GPS fix, home position, armable).
      5. Upload fixed benign synthetic route.
      6. Arm and start mission.
      7. Stream timestamped position/speed telemetry and confirm motion along route.
    """
    validate_safe_address(address)
    if manage_docker:
        raise SimulatorError("Use the --docker CLI option for isolated simulation.")

    if not MAVSDK_AVAILABLE:
        raise PrerequisiteMissingError(
            "MAVSDK package is not installed. Run: pip install mavsdk-grpc"
        )

    drone = System()
    try:
        print(f"[CONNECT] Connecting to local simulator at {address}...")
        start_wait = time.monotonic()
        startup_deadline = start_wait + startup_timeout
        try:
            await asyncio.wait_for(drone.connect(system_address=address), startup_timeout)
        except asyncio.TimeoutError as exc:
            raise StartupTimeoutError("MAVSDK connection setup timed out.") from exc

        # 1. Bounded wait for connection
        print(f"[STARTUP] Waiting for simulator connection (timeout: {startup_timeout}s)...")

        async def wait_connection() -> None:
            async for state in drone.core.connection_state():
                if state.is_connected:
                    return

        try:
            await asyncio.wait_for(wait_connection(), timeout=startup_deadline - time.monotonic())
            print(f"[STARTUP] Connected to simulator in {time.monotonic() - start_wait:.1f}s.")
        except asyncio.TimeoutError:
            raise StartupTimeoutError(
                f"Simulator connection timed out after {startup_timeout}s at {address}. "
                "Ensure PX4 SITL/SIH is running locally."
            )

        # 2. Bounded wait for preflight health
        remaining_startup = startup_deadline - time.monotonic()
        print(f"[STARTUP] Waiting for preflight health (armable, GPS fix, home pos) up to {remaining_startup:.1f}s...")

        async def wait_healthy() -> None:
            async for health in drone.telemetry.health():
                if health.is_armable and health.is_global_position_ok and health.is_home_position_ok:
                    return
                await asyncio.sleep(0.5)

        try:
            await asyncio.wait_for(wait_healthy(), timeout=remaining_startup)
            print(f"[STARTUP] Preflight health confirmed in {time.monotonic() - start_wait:.1f}s.")
        except asyncio.TimeoutError:
            raise StartupTimeoutError(
                f"Preflight readiness timed out after {startup_timeout}s. "
                "Vehicle did not reach armable state with valid GPS and home lock."
            )

        # 3. Read initial position
        try:
            initial_pos = await read_sample(drone.telemetry.position(), startup_deadline - time.monotonic())
        except (asyncio.TimeoutError, StopAsyncIteration) as exc:
            raise StartupTimeoutError("Initial position telemetry was unavailable.") from exc

        print(
            f"[TELEMETRY] Starting Origin: Lat={initial_pos.latitude_deg:.6f}, "
            f"Lon={initial_pos.longitude_deg:.6f}, RelAlt={initial_pos.relative_altitude_m:.2f}m"
        )

        # 4. Generate and upload synthetic route
        print(f"[ROUTE] Generating fixed benign synthetic route (alt={route_alt}m, speed={route_speed}m/s)...")
        items = generate_synthetic_route(
            home_lat=initial_pos.latitude_deg,
            home_lon=initial_pos.longitude_deg,
            alt_m=route_alt,
            speed_m_s=route_speed,
        )
        plan = MissionPlan(items)
        print(f"[ROUTE] Uploading {len(items)} synthetic waypoints to autopilot...")
        try:
            await asyncio.wait_for(drone.mission.upload_mission(plan), startup_timeout)
            print("[ROUTE] Mission plan successfully uploaded.")
        except Exception as exc:
            raise SimulatorError(f"Failed to upload mission plan: {exc}")

        # 5. Arm and start mission
        print("[FLIGHT] Arming vehicle...")
        try:
            await asyncio.wait_for(drone.action.arm(), startup_timeout)
            print("[FLIGHT] Vehicle armed. Starting autonomous route...")
            await asyncio.wait_for(drone.mission.start_mission(), startup_timeout)
            print("[FLIGHT] Mission started. Monitoring telemetry for motion along route...")
        except Exception as exc:
            raise SimulatorError(f"Failed to arm or start mission: {exc}")

        # 6. Stream telemetry and verify motion
        detector = MotionDetector(
            home_lat=initial_pos.latitude_deg,
            home_lon=initial_pos.longitude_deg,
            home_alt=initial_pos.relative_altitude_m,
            min_displacement_m=2.0,
            min_speed_m_s=0.5,
            required_samples=3,
        )

        flight_start = time.monotonic()
        print("\n--- Live Timestamped Telemetry ---")
        print(f"{'Timestamp':<28} {'Elapsed':<9} {'Latitude':<12} {'Longitude':<12} {'RelAlt':<8} {'NorthSpeed':<10} {'NorthProgress':<12} {'Status'}")
        print("-" * 105)

        motion_confirmed = False
        while time.monotonic() - flight_start < motion_timeout:
            await asyncio.sleep(0.4)
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

        if not motion_confirmed:
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
        if hasattr(drone, "_stop_mavsdk_server"):
            try:
                drone._stop_mavsdk_server()
            except Exception:
                pass
        if hasattr(drone, "_server_process") and drone._server_process:
            try:
                drone._server_process.kill()
            except Exception:
                pass


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
    parsed = parser.parse_args(args)
    for name in ("startup_timeout", "motion_timeout", "alt", "speed"):
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

    try:
        if args.docker:
            return run_isolated_docker(args)
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
        print(f"\nERROR [SAFETY_VIOLATION]: {err}", file=sys.stderr)
        return 4
    except PrerequisiteMissingError as err:
        print(f"\nERROR [PREREQUISITE_MISSING]: {err}", file=sys.stderr)
        return 5
    except StartupTimeoutError as err:
        print(f"\nERROR [STARTUP_TIMEOUT]: {err}", file=sys.stderr)
        return 2
    except MotionTimeoutError as err:
        print(f"\nERROR [MOTION_TIMEOUT]: {err}", file=sys.stderr)
        return 3
    except SimulatorError as err:
        print(f"\nERROR [SIMULATOR_ERROR]: {err}", file=sys.stderr)
        return 1
    except Exception as err:
        print(f"\nERROR [UNEXPECTED_FAILURE]: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
