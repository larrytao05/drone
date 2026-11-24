#!/usr/bin/env python3
"""
SIM-1 Shared Utilities, Data Structures, and Autopilot Coordination.

Provides:
  - Address safety verification and hardware interface blocking
  - Benign synthetic waypoint route generation
  - MotionDetector for validating sustained displacement and speed
  - Docker container cleanup helpers
  - Shared MAVSDK preflight, startup, and teardown
  - Structured interactive JSON-line emission
"""

from __future__ import annotations

import asyncio
import datetime
import json
import math
import re
import signal
import subprocess
import sys
import time
from contextlib import aclosing
from typing import Any, Callable, Dict, List, Optional, Tuple

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
            items.append({
                "latitude_deg": wp_lat,
                "longitude_deg": wp_lon,
                "relative_altitude_m": alt_m,
                "speed_m_s": speed_m_s,
            })
    return items


def build_route_legs(
    home_lat: float, home_lon: float, waypoints: List[Dict[str, Any]]
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """
    Construct route legs metadata including takeoff and adjacent waypoint-to-waypoint legs.
    """
    first_wp = waypoints[0]
    first_lat = float(first_wp.get("latitudeDeg") if "latitudeDeg" in first_wp else first_wp.get("latitude_deg", first_wp.get("lat", 0.0)))
    first_lon = float(first_wp.get("longitudeDeg") if "longitudeDeg" in first_wp else first_wp.get("longitude_deg", first_wp.get("lon", 0.0)))
    d_n, d_e, _, dist = calculate_displacement(home_lat, home_lon, 0.0, first_lat, first_lon, 0.0)
    takeoff_leg = {
        "stage": "takeoff",
        "from_lat": home_lat,
        "from_lon": home_lon,
        "to_lat": first_lat,
        "to_lon": first_lon,
        "unit_north": d_n / dist if dist > 0 else 1.0,
        "unit_east": d_e / dist if dist > 0 else 0.0,
        "distance_m": dist,
        "to_waypoint_index": 0,
        "to_waypoint_id": first_wp.get("id"),
    }

    legs: List[Dict[str, Any]] = []
    for i in range(len(waypoints) - 1):
        wp_a = waypoints[i]
        wp_b = waypoints[i + 1]
        lat_a = float(wp_a.get("latitudeDeg") if "latitudeDeg" in wp_a else wp_a.get("latitude_deg", wp_a.get("lat", 0.0)))
        lon_a = float(wp_a.get("longitudeDeg") if "longitudeDeg" in wp_a else wp_a.get("longitude_deg", wp_a.get("lon", 0.0)))
        lat_b = float(wp_b.get("latitudeDeg") if "latitudeDeg" in wp_b else wp_b.get("latitude_deg", wp_b.get("lat", 0.0)))
        lon_b = float(wp_b.get("longitudeDeg") if "longitudeDeg" in wp_b else wp_b.get("longitude_deg", wp_b.get("lon", 0.0)))

        d_n, d_e, _, leg_dist = calculate_displacement(lat_a, lon_a, 0.0, lat_b, lon_b, 0.0)
        u_n = d_n / leg_dist if leg_dist > 0 else 1.0
        u_e = d_e / leg_dist if leg_dist > 0 else 0.0
        legs.append({
            "stage": "leg",
            "leg_index": i,
            "from_waypoint_index": i,
            "to_waypoint_index": i + 1,
            "from_waypoint_id": wp_a.get("id"),
            "to_waypoint_id": wp_b.get("id"),
            "from_lat": lat_a,
            "from_lon": lon_a,
            "to_lat": lat_b,
            "to_lon": lon_b,
            "unit_north": u_n,
            "unit_east": u_e,
            "distance_m": leg_dist,
        })
    return takeoff_leg, legs


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
        leg_unit: Tuple[float, float] = (1.0, 0.0),
        takeoff_leg: Optional[Dict[str, Any]] = None,
        legs: Optional[List[Dict[str, Any]]] = None,
    ):
        self.home_lat = home_lat
        self.home_lon = home_lon
        self.home_alt = home_alt
        self.min_displacement_m = min_displacement_m
        self.min_speed_m_s = min_speed_m_s
        self.required_samples = required_samples
        self.unit_north, self.unit_east = leg_unit
        self.takeoff_leg = takeoff_leg
        self.legs = legs or []

        self.current_origin_lat = home_lat
        self.current_origin_lon = home_lon
        self.active_leg_stage = "takeoff" if takeoff_leg else "leg"
        self.active_leg_index = 0

        if self.active_leg_stage == "takeoff" and takeoff_leg:
            self.unit_north = takeoff_leg.get("unit_north", self.unit_north)
            self.unit_east = takeoff_leg.get("unit_east", self.unit_east)
        elif self.legs:
            leg = self.legs[0]
            self.current_origin_lat = leg["from_lat"]
            self.current_origin_lon = leg["from_lon"]
            self.unit_north = leg["unit_north"]
            self.unit_east = leg["unit_east"]

        self.consecutive_moving_samples = 0
        self.max_speed_observed = 0.0
        self.max_displacement_observed = 0.0
        self.is_confirmed = False
        self.history: List[Dict[str, Any]] = []

    def switch_leg(self, leg_index: int) -> None:
        """Switch active tracking to a waypoint-to-waypoint leg."""
        if self.legs and 0 <= leg_index < len(self.legs):
            self.active_leg_stage = "leg"
            self.active_leg_index = leg_index
            leg = self.legs[leg_index]
            self.current_origin_lat = leg["from_lat"]
            self.current_origin_lon = leg["from_lon"]
            self.unit_north = leg["unit_north"]
            self.unit_east = leg["unit_east"]
            self.consecutive_moving_samples = 0
            self.max_speed_observed = 0.0
            self.max_displacement_observed = 0.0
            self.is_confirmed = False

    def set_completed(self) -> None:
        """Mark mission completed at final waypoint."""
        self.active_leg_stage = "completed"
        self.unit_north = 0.0
        self.unit_east = 0.0
        self.consecutive_moving_samples = 0

    def record_sample(
        self,
        lat: float,
        lon: float,
        rel_alt: float,
        speed_m_s: float,
        elapsed_s: float,
        iso_timestamp: Optional[str] = None,
        vel_north_m_s: Optional[float] = None,
        vel_east_m_s: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Record and evaluate a telemetry sample."""
        if iso_timestamp is None:
            iso_timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()

        d_north_home, d_east_home, _, _ = calculate_displacement(
            self.home_lat, self.home_lon, self.home_alt,
            lat, lon, rel_alt
        )

        d_north_leg, d_east_leg, _, _ = calculate_displacement(
            self.current_origin_lat, self.current_origin_lon, self.home_alt,
            lat, lon, rel_alt
        )

        # Horizontal progress along the active leg direction
        progress_m = d_north_leg * self.unit_north + d_east_leg * self.unit_east

        if vel_north_m_s is not None and vel_east_m_s is not None:
            leg_speed_m_s = vel_north_m_s * self.unit_north + vel_east_m_s * self.unit_east
        else:
            leg_speed_m_s = speed_m_s

        if leg_speed_m_s > self.max_speed_observed:
            self.max_speed_observed = leg_speed_m_s
        if progress_m > self.max_displacement_observed:
            self.max_displacement_observed = progress_m

        is_moving_sample = (progress_m >= self.min_displacement_m and leg_speed_m_s >= self.min_speed_m_s)
        if is_moving_sample:
            self.consecutive_moving_samples += 1
        else:
            self.consecutive_moving_samples = 0

        if self.consecutive_moving_samples >= self.required_samples:
            self.is_confirmed = True

        active_leg: Dict[str, Any] = {"stage": self.active_leg_stage}
        if self.active_leg_stage == "leg" and self.legs and self.active_leg_index < len(self.legs):
            leg = self.legs[self.active_leg_index]
            active_leg.update({
                "leg_index": self.active_leg_index,
                "from_waypoint_index": leg["from_waypoint_index"],
                "to_waypoint_index": leg["to_waypoint_index"],
                "from_waypoint_id": leg.get("from_waypoint_id"),
                "to_waypoint_id": leg.get("to_waypoint_id"),
                "leg_progress_m": progress_m,
                "leg_total_distance_m": leg["distance_m"],
            })
        elif self.active_leg_stage == "takeoff":
            active_leg.update({
                "from_waypoint_index": 0,
                "to_waypoint_index": 0,
                "leg_progress_m": progress_m,
                "leg_total_distance_m": self.takeoff_leg.get("distance_m", 0.0) if self.takeoff_leg else 0.0,
            })

        sample_data = {
            "timestamp": iso_timestamp,
            "elapsed_s": elapsed_s,
            "lat": lat,
            "lon": lon,
            "alt_m": rel_alt,
            "speed_m_s": speed_m_s,
            "leg_speed_m_s": leg_speed_m_s,
            "progress_m": progress_m,
            "north_progress_m": d_north_home,
            "is_moving": is_moving_sample,
            "confirmed": self.is_confirmed,
            "active_leg": active_leg,
        }
        self.history.append(sample_data)
        return sample_data


def remove_simulator_containers(containers: tuple[str, ...]) -> bool:
    """Safely remove isolated simulator containers, shielding from external aborts."""
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


def emit_interactive(event_type: str, data: Dict[str, Any]) -> None:
    """Emit a structured JSON-line to stdout for the interactive bridge session."""
    payload = {"type": event_type, **data}
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


async def read_sample(stream: Any, timeout: float) -> Any:
    """Read a single item from an async iterator with a bounded timeout."""
    async with aclosing(stream):
        return await asyncio.wait_for(anext(stream), timeout)


async def route_sample(drone: Any, origin: Any, deadline: float) -> tuple[float, float, float]:
    """Sample position and velocity relative to an origin point with bounded deadline."""
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


async def cleanup_drone(drone: Any) -> None:
    """Shared teardown helper for MAVSDK system and background server processes."""
    if drone is None:
        return
    if hasattr(drone, "_stop_mavsdk_server") and callable(drone._stop_mavsdk_server):
        try:
            res = drone._stop_mavsdk_server()
            if asyncio.iscoroutine(res):
                await res
        except Exception:
            pass
    if hasattr(drone, "_server_process") and drone._server_process:
        try:
            if hasattr(drone._server_process, "kill") and callable(drone._server_process.kill):
                res = drone._server_process.kill()
                if asyncio.iscoroutine(res):
                    await res
        except Exception:
            pass


async def sim1_startup(
    address: str,
    startup_timeout: float = 30.0,
    route_alt: float = 10.0,
    route_speed: float = 4.0,
    event_callback: Optional[Callable[[str], None]] = None,
    custom_waypoints: Optional[List[Dict[str, Any]]] = None,
) -> tuple[Any, Any, list[Any], MotionDetector]:
    """
    Shared preflight & startup sequence for SIM-1:
      1. Validate safe loopback address and prerequisite MAVSDK availability.
      2. Connect and wait for connection state.
      3. Wait for preflight health (armable, GPS fix, home pos lock).
      4. Read initial position.
      5. Generate and upload synthetic route mission.
      6. Arm vehicle and start mission.
      7. Initialize and return (drone, initial_pos, route_items, detector).
    """
    validate_safe_address(address)
    if not MAVSDK_AVAILABLE:
        raise PrerequisiteMissingError(
            "MAVSDK package is not installed. Run: pip install mavsdk-grpc"
        )

    def report(msg: str) -> None:
        if event_callback:
            event_callback(msg)

    drone = System()
    try:
        start_wait = time.monotonic()
        startup_deadline = start_wait + startup_timeout

        report(f"Connecting to local simulator at {address}")
        try:
            await asyncio.wait_for(drone.connect(system_address=address), startup_timeout)
        except asyncio.TimeoutError as exc:
            raise StartupTimeoutError("MAVSDK connection setup timed out.") from exc

        # 1. Bounded wait for connection
        async def wait_connection() -> None:
            async for state in drone.core.connection_state():
                if state.is_connected:
                    return

        try:
            await asyncio.wait_for(wait_connection(), timeout=startup_deadline - time.monotonic())
            report(f"Connected to simulator in {time.monotonic() - start_wait:.1f}s")
        except asyncio.TimeoutError:
            raise StartupTimeoutError(
                f"Simulator connection timed out after {startup_timeout}s at {address}. "
                "Ensure PX4 SITL/SIH is running locally."
            )

        # 2. Bounded wait for preflight health
        remaining_startup = startup_deadline - time.monotonic()

        async def wait_healthy() -> None:
            async for health in drone.telemetry.health():
                if health.is_armable and health.is_global_position_ok and health.is_home_position_ok:
                    return
                await asyncio.sleep(0.5)

        try:
            await asyncio.wait_for(wait_healthy(), timeout=remaining_startup)
            report(f"Preflight health confirmed in {time.monotonic() - start_wait:.1f}s")
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

        report(f"Starting Origin: Lat={initial_pos.latitude_deg:.6f}, Lon={initial_pos.longitude_deg:.6f}")

        # 4. Generate and upload route
        leg_unit = (1.0, 0.0)
        takeoff_leg = None
        legs = None
        if custom_waypoints and len(custom_waypoints) >= 2:
            takeoff_leg, legs = build_route_legs(initial_pos.latitude_deg, initial_pos.longitude_deg, custom_waypoints)
            first_wp = custom_waypoints[0]
            first_lat = float(first_wp.get("latitudeDeg") if "latitudeDeg" in first_wp else first_wp.get("latitude_deg", first_wp.get("lat", 0.0)))
            first_lon = float(first_wp.get("longitudeDeg") if "longitudeDeg" in first_wp else first_wp.get("longitude_deg", first_wp.get("lon", 0.0)))

            d_n, d_e, _, _ = calculate_displacement(
                initial_pos.latitude_deg, initial_pos.longitude_deg, 0.0,
                first_lat, first_lon, 0.0,
            )
            horiz_dist = math.hypot(d_n, d_e)

            if horiz_dist < 1.0 and len(custom_waypoints) >= 2:
                second_wp = custom_waypoints[1]
                second_lat = float(second_wp.get("latitudeDeg") if "latitudeDeg" in second_wp else second_wp.get("latitude_deg", second_wp.get("lat", 0.0)))
                second_lon = float(second_wp.get("longitudeDeg") if "longitudeDeg" in second_wp else second_wp.get("longitude_deg", second_wp.get("lon", 0.0)))
                d_n, d_e, _, _ = calculate_displacement(
                    initial_pos.latitude_deg, initial_pos.longitude_deg, 0.0,
                    second_lat, second_lon, 0.0,
                )
                horiz_dist = math.hypot(d_n, d_e)

            if horiz_dist < 20.0:
                raise SimulatorError(
                    f"Initial route leg is too short or degenerate ({horiz_dist:.1f}m < 20.0m). "
                    "Custom simulation scenarios require an initial leg of at least 20m."
                )

            leg_unit = (d_n / horiz_dist, d_e / horiz_dist)

            items = []
            for idx, wp in enumerate(custom_waypoints):
                lat = float(wp.get("latitudeDeg") if "latitudeDeg" in wp else wp.get("latitude_deg", wp.get("lat", 0.0)))
                lon = float(wp.get("longitudeDeg") if "longitudeDeg" in wp else wp.get("longitude_deg", wp.get("lon", 0.0)))
                alt = float(wp.get("altitudeM") if "altitudeM" in wp else wp.get("relative_altitude_m", wp.get("alt_m", route_alt)))
                spd = float(wp.get("speedMs") if "speedMs" in wp else wp.get("speed_m_s", route_speed))

                if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0 and alt > 0):
                    raise SimulatorError(f"Waypoint {idx + 1} has invalid coordinate or altitude.")

                # Verify distance from local simulator origin is within reasonable local boundary (10km)
                _, _, _, dist_m = calculate_displacement(
                    initial_pos.latitude_deg, initial_pos.longitude_deg, initial_pos.relative_altitude_m,
                    lat, lon, alt
                )
                if dist_m > 10000.0:
                    raise SafetyViolationError(
                        f"Waypoint {idx + 1} ({lat:.4f}, {lon:.4f}) is {dist_m / 1000.0:.1f} km from simulator origin. "
                        "Software simulation requires routes within 10 km of the local simulator origin."
                    )

                if MissionItem is not None:
                    items.append(
                        MissionItem(
                            latitude_deg=lat,
                            longitude_deg=lon,
                            relative_altitude_m=alt,
                            speed_m_s=spd,
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
                    items.append({
                        "latitude_deg": lat,
                        "longitude_deg": lon,
                        "relative_altitude_m": alt,
                        "speed_m_s": spd,
                    })
            plan = MissionPlan(items)
            try:
                await asyncio.wait_for(drone.mission.upload_mission(plan), startup_timeout)
                report(f"Mission plan with {len(items)} custom waypoints uploaded")
                emit_interactive("route", {"waypoints": custom_waypoints})
            except Exception as exc:
                raise SimulatorError(f"Failed to upload mission plan: {exc}")
        else:
            items = generate_synthetic_route(
                home_lat=initial_pos.latitude_deg,
                home_lon=initial_pos.longitude_deg,
                alt_m=route_alt,
                speed_m_s=route_speed,
            )
            plan = MissionPlan(items)
            try:
                await asyncio.wait_for(drone.mission.upload_mission(plan), startup_timeout)
                report(f"Mission plan with {len(items)} synthetic waypoints uploaded")
            except Exception as exc:
                raise SimulatorError(f"Failed to upload mission plan: {exc}")

        # 5. Arm and start mission
        try:
            await asyncio.wait_for(drone.action.arm(), startup_timeout)
            await asyncio.wait_for(drone.mission.start_mission(), startup_timeout)
            report("Mission started")
        except Exception as exc:
            raise SimulatorError(f"Failed to arm or start mission: {exc}")

        detector = MotionDetector(
            home_lat=initial_pos.latitude_deg,
            home_lon=initial_pos.longitude_deg,
            home_alt=initial_pos.relative_altitude_m,
            min_displacement_m=2.0,
            min_speed_m_s=0.5,
            required_samples=3,
            leg_unit=leg_unit,
            takeoff_leg=takeoff_leg,
            legs=legs,
        )

        return drone, initial_pos, items, detector

    except Exception:
        await cleanup_drone(drone)
        raise
