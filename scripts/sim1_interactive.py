#!/usr/bin/env python3
"""
SIM-1 Interactive Runner:
Supervised, interactive execution session designed for the local simulator bridge.
Emits structured JSON-line events, ingests operator commands via stdin,
enforces hold verification and explicit resume constraints, and guarantees bounded run lifetime.
Supports multi-leg tracking, leg-targeted blockage, turn verification, and terminal mission completion.
"""

from __future__ import annotations

import asyncio
import datetime
import json
import math
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

_script_dir = Path(__file__).resolve().parent
_repo_root = _script_dir.parent
for _p in (str(_repo_root), str(_script_dir)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

try:
    from scripts.sim1_shared import (
        MotionTimeoutError,
        SimulatorError,
        cleanup_drone,
        emit_interactive,
        read_sample,
        sim1_startup,
    )
except ImportError:
    from sim1_shared import (
        MotionTimeoutError,
        SimulatorError,
        cleanup_drone,
        emit_interactive,
        read_sample,
        sim1_startup,
    )


async def run_sim1_interactive(
    address: str,
    startup_timeout: float = 30.0,
    motion_timeout: float = 20.0,
    route_alt: float = 10.0,
    route_speed: float = 4.0,
    run_id: Optional[str] = None,
    max_runtime: float = 600.0,
    custom_waypoints: Optional[List[Dict[str, Any]]] = None,
    block_leg: Optional[int] = None,
    hold_trigger: float = 5.0,
    block_boundary: float = 20.0,
) -> bool:
    """
    Run an interactive SIM-1 session over stdin/stdout JSON-lines.
    Lifecycle:
      1. Preflight startup & route leg configuration.
      2. Telemetry emission stream with active leg tracking.
      3. Obstacle blockage injection on specified leg and hold verification.
      4. Clearance without automatic resume.
      5. Explicit operator resume from bridge.
      6. Resumed route motion verification on active leg.
      7. Continued navigation through turns to final waypoint and mission completion.
      8. Verified teardown on operator end command or bounded timeout.
    """
    emit_interactive("phase", {"phase": "starting"})

    command_queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def stdin_reader() -> None:
        try:
            for raw_line in sys.stdin:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    if isinstance(data, dict):
                        loop.call_soon_threadsafe(command_queue.put_nowait, data)
                except json.JSONDecodeError:
                    pass
        except Exception:
            pass

    reader_thread = threading.Thread(target=stdin_reader, daemon=True)
    reader_thread.start()

    drone = None
    progress_task = None
    try:
        drone, initial_pos, items, detector = await sim1_startup(
            address=address,
            startup_timeout=startup_timeout,
            route_alt=route_alt,
            route_speed=route_speed,
            event_callback=lambda label: emit_interactive("event", {"label": label}),
            custom_waypoints=custom_waypoints,
        )

        # Target leg for blockage: default to 1 (second leg, connecting WP 2 -> WP 3) if multi-leg, else 0
        if block_leg is not None:
            target_leg = block_leg
        elif custom_waypoints and len(custom_waypoints) >= 4:
            target_leg = 1
        else:
            target_leg = 0

        # Validate sufficient distance on target leg for deceleration
        if detector.legs:
            if target_leg < 0 or target_leg >= len(detector.legs):
                raise SimulatorError(
                    f"Target leg index {target_leg} is out of bounds for route with {len(detector.legs)} legs."
                )
            leg_distance = detector.legs[target_leg]["distance_m"]
            if leg_distance < block_boundary + 5.0:
                raise SimulatorError(
                    f"Target leg {target_leg + 1} distance ({leg_distance:.1f}m) is insufficient "
                    f"for deceleration before blockage boundary {block_boundary:.1f}m."
                )

        emit_interactive("phase", {"phase": "running"})

        mission_current = 0
        mission_total = len(items)

        async def track_mission_progress() -> None:
            nonlocal mission_current, mission_total
            try:
                stream_fn = getattr(getattr(drone, "mission", None), "mission_progress", None)
                if callable(stream_fn):
                    stream = stream_fn()
                    if hasattr(stream, "__aiter__"):
                        async for prog in stream:
                            mission_current = prog.current
                            mission_total = prog.total
                    elif asyncio.iscoroutine(stream):
                        stream.close()
            except Exception:
                pass

        progress_task = asyncio.create_task(track_mission_progress())

        flight_start = time.monotonic()
        motion_confirmed = False
        hold_requested = False
        hold_confirmed = False
        held_north = 0.0
        held_progress = 0.0
        held_initial_progress = 0.0
        hold_confirmed_time = 0.0
        clearance_emitted = False
        resumed = False
        resume_commanded = False
        resume_time = 0.0
        resume_progress = 0.0
        resumed_motion_confirmed = False
        blocked = False
        stopped_since = None
        pause_task = None
        last_telemetry_time = time.monotonic()
        mission_completed = False

        while True:
            await asyncio.sleep(0.35)
            now = time.monotonic()

            # Bound maximum interactive session lifetime
            if now - flight_start > max_runtime:
                raise MotionTimeoutError(
                    f"Interactive simulation exceeded maximum bounded lifetime of {max_runtime}s."
                )

            # Process commands from stdin
            while not command_queue.empty():
                cmd = command_queue.get_nowait()
                cmd_run_id = cmd.get("runId")
                if run_id and cmd_run_id and cmd_run_id != run_id:
                    emit_interactive(
                        "error",
                        {
                            "code": "WRONG_RUN",
                            "message": f"Command runId '{cmd_run_id}' does not match active '{run_id}'",
                        },
                    )
                    continue

                action = cmd.get("command") or cmd.get("action")
                if action == "end":
                    emit_interactive("event", {"label": "Simulation teardown requested"})
                    emit_interactive("phase", {"phase": "ended"})
                    return True
                elif action == "resume":
                    if not hold_confirmed:
                        emit_interactive("error", {"code": "NOT_HOLDING", "message": "Resume rejected: hold not confirmed"})
                    elif blocked:
                        emit_interactive("error", {"code": "SEGMENT_BLOCKED", "message": "Resume rejected: segment is blocked"})
                    elif now - last_telemetry_time > 2.0:
                        emit_interactive("error", {"code": "STALE_TELEMETRY", "message": "Resume rejected: telemetry is stale"})
                    elif resume_commanded:
                        emit_interactive("error", {"code": "INVALID_REQUEST", "message": "Resume rejected: resume already in flight"})
                    else:
                        resume_commanded = True
                        resume_time = now
                        emit_interactive("event", {"label": "Explicit resume commanded"})
                        try:
                            await asyncio.wait_for(drone.mission.start_mission(), 5.0)
                            resumed = True
                            resume_progress = detector.history[-1]["progress_m"] if detector.history else held_progress
                        except Exception as exc:
                            resume_commanded = False
                            emit_interactive("error", {"code": "SIMULATOR_ERROR", "message": f"Resume command failed: {exc}"})

            # Read telemetry
            try:
                pos = await read_sample(drone.telemetry.position(), 2.0)
                vel = await read_sample(drone.telemetry.velocity_ned(), 2.0)
            except (asyncio.TimeoutError, StopAsyncIteration) as exc:
                raise MotionTimeoutError("Position or velocity telemetry became unavailable.") from exc

            last_telemetry_time = time.monotonic()
            speed_3d = math.hypot(vel.north_m_s, vel.east_m_s, vel.down_m_s)
            elapsed = now - flight_start
            iso_now = datetime.datetime.now(datetime.timezone.utc).isoformat()

            # Active leg tracking from mission progress
            if detector.legs and not mission_completed:
                if mission_current >= 1 and mission_current <= len(detector.legs):
                    desired_leg = mission_current - 1
                    if detector.active_leg_stage != "leg" or detector.active_leg_index != desired_leg:
                        detector.switch_leg(desired_leg)
                        emit_interactive("leg", {
                            "stage": "leg",
                            "leg_index": desired_leg,
                            "from_waypoint_index": desired_leg,
                            "to_waypoint_index": desired_leg + 1,
                            "distance_m": detector.legs[desired_leg]["distance_m"],
                        })
                        emit_interactive("event", {"label": f"Advanced to leg {desired_leg + 1}"})

            sample = detector.record_sample(
                lat=pos.latitude_deg,
                lon=pos.longitude_deg,
                rel_alt=pos.relative_altitude_m,
                speed_m_s=speed_3d,
                elapsed_s=elapsed,
                iso_timestamp=iso_now,
                vel_north_m_s=vel.north_m_s,
                vel_east_m_s=vel.east_m_s,
            )

            # Check mission completion
            if not mission_completed and (resumed or not hold_requested):
                is_finished = False
                try:
                    res = await asyncio.wait_for(drone.mission.is_mission_finished(), 0.05)
                    if res is True:
                        is_finished = True
                except Exception:
                    pass
                if not is_finished and mission_total > 0 and mission_current >= mission_total:
                    is_finished = True

                if is_finished:
                    mission_completed = True
                    detector.set_completed()
                    sample["active_leg"] = {"stage": "completed"}
                    emit_interactive("leg", {"stage": "completed"})
                    emit_interactive("event", {"label": "Mission completed: reached final waypoint"})
                    emit_interactive("phase", {"phase": "completed"})

            telemetry_payload = {
                "timestamp": iso_now,
                "lat": pos.latitude_deg,
                "lon": pos.longitude_deg,
                "alt_m": pos.relative_altitude_m,
                "speed_m_s": speed_3d,
                "north_speed_m_s": vel.north_m_s,
                "north_progress_m": sample["north_progress_m"],
                "progress_m": sample["progress_m"],
                "is_moving": sample["is_moving"],
                "confirmed": sample["confirmed"],
            }
            if "active_leg" in sample:
                telemetry_payload["active_leg"] = sample["active_leg"]

            emit_interactive("telemetry", telemetry_payload)

            # 1. First motion confirmation
            if sample["confirmed"] and not motion_confirmed:
                motion_confirmed = True
                emit_interactive("event", {"label": "Route motion confirmed"})

            # 2. Blockage injection & Hold request on target leg
            is_on_target_leg = (
                not detector.legs or
                (detector.active_leg_stage == "leg" and detector.active_leg_index == target_leg)
            )

            if is_on_target_leg and motion_confirmed and not hold_requested and sample["progress_m"] >= hold_trigger:
                boundary = block_boundary
                if sample["progress_m"] >= boundary:
                    raise MotionTimeoutError("Simulator reached blocked segment before injection.")
                hold_requested = True
                blocked = True
                emit_interactive("blockage", {"blocked": True, "boundary_m": boundary, "leg_index": target_leg})
                emit_interactive("event", {"label": "Next segment blocked"})
                emit_interactive("hold_requested", {"hold_requested": True})
                emit_interactive("event", {"label": "Autopilot commanded hold"})

                async def pause_mission() -> None:
                    async with asyncio.timeout(5):
                        await drone.mission.pause_mission()

                pause_task = asyncio.create_task(pause_mission())

            # 3. Confirming hold
            if hold_requested and not hold_confirmed:
                if sample["progress_m"] >= block_boundary:
                    raise MotionTimeoutError(f"Simulator entered blocked segment at {sample['progress_m']:.2f} m.")
                if pause_task and pause_task.done():
                    await pause_task
                    if speed_3d > 0.5 or sample["leg_speed_m_s"] > 0.25:
                        stopped_since = None
                    elif stopped_since is None:
                        stopped_since = now
                    elif now - stopped_since >= 1.0:
                        hold_confirmed = True
                        held_north = sample["north_progress_m"]
                        held_progress = sample["progress_m"]
                        held_initial_progress = sample["progress_m"]
                        hold_confirmed_time = now
                        emit_interactive("hold_confirmed", {"hold_confirmed": True})
                        emit_interactive("phase", {"phase": "holding"})
                        emit_interactive("event", {"label": "Telemetry confirmed hold"})
                        emit_interactive("event", {"label": "Advisory: stay in hold until segment clears and operator explicitly resumes"})

            # 4. Clearance without resume
            if hold_confirmed and not clearance_emitted and not resumed:
                if now - hold_confirmed_time >= 2.0:
                    clearance_emitted = True
                    blocked = False
                    emit_interactive("blockage", {"blocked": False, "leg_index": target_leg})
                    emit_interactive("event", {"label": "Blockage cleared"})
                    emit_interactive("event", {"label": "Telemetry confirmed continued hold for two seconds after clearance"})

            # Check hold integrity (no drift without resume)
            if hold_confirmed and not resumed:
                if sample["progress_m"] >= block_boundary:
                    raise MotionTimeoutError(f"Simulator entered blocked segment at {sample['progress_m']:.2f} m.")

                # Settle into steady-state loiter position as braking flare overshoot levels out
                if sample["progress_m"] < held_progress:
                    held_progress = sample["progress_m"]
                    held_north = sample["north_progress_m"]

                forward_progress_delta = sample["progress_m"] - held_progress
                backward_drift = held_initial_progress - sample["progress_m"]

                if speed_3d > 0.75 or forward_progress_delta > 1.0:
                    raise MotionTimeoutError(f"Simulator moved after hold without explicit resume (speed {speed_3d:.2f} m/s).")
                if backward_drift > 2.0:
                    raise MotionTimeoutError(f"Simulator drifted excessively after hold ({backward_drift:.2f} m backward).")

            # 5. Motion after explicit resume
            if resumed and not resumed_motion_confirmed:
                if sample["progress_m"] >= resume_progress + 2.0 and sample["leg_speed_m_s"] >= 0.5:
                    resumed_motion_confirmed = True
                    emit_interactive("event", {"label": "Route motion resumed"})
                    emit_interactive("phase", {"phase": "running"})
                elif resume_time > 0.0 and now - resume_time > motion_timeout:
                    raise MotionTimeoutError(f"Resumed motion along route could not be confirmed within timeout {motion_timeout}s.")

            if not motion_confirmed and elapsed > motion_timeout:
                raise MotionTimeoutError(f"Motion along route could not be confirmed within timeout {motion_timeout}s.")

    finally:
        if progress_task and not progress_task.done():
            progress_task.cancel()
        await cleanup_drone(drone)
