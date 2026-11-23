#!/usr/bin/env python3
"""
SIM-1 Interactive Runner:
Supervised, interactive execution session designed for the local simulator bridge.
Emits structured JSON-line events, ingests operator commands via stdin,
enforces hold verification and explicit resume constraints, and guarantees bounded run lifetime.
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
from typing import Any, Dict, Optional

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
) -> bool:
    """
    Run an interactive SIM-1 session over stdin/stdout JSON-lines.
    Lifecycle:
      1. Preflight startup (shared with smoke test).
      2. Telemetry emission stream.
      3. Obstacle blockage injection and hold verification.
      4. Clearance without automatic resume.
      5. Explicit operator resume from bridge.
      6. Resumed route motion verification.
      7. Verified teardown on operator end command or bounded timeout.
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
    try:
        drone, initial_pos, items, detector = await sim1_startup(
            address=address,
            startup_timeout=startup_timeout,
            route_alt=route_alt,
            route_speed=route_speed,
            event_callback=lambda label: emit_interactive("event", {"label": label}),
        )

        emit_interactive("phase", {"phase": "running"})

        flight_start = time.monotonic()
        motion_confirmed = False
        hold_requested = False
        hold_confirmed = False
        held_north = 0.0
        hold_confirmed_time = 0.0
        clearance_emitted = False
        resumed = False
        resume_commanded = False
        resume_north = 0.0
        resumed_motion_confirmed = False
        blocked = False
        stopped_since = None
        pause_task = None
        last_telemetry_time = time.monotonic()

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
                        # Prevent duplicate in-flight resume command
                        emit_interactive("error", {"code": "INVALID_REQUEST", "message": "Resume rejected: resume already in flight"})
                    else:
                        resume_commanded = True
                        emit_interactive("event", {"label": "Explicit resume commanded"})
                        try:
                            await asyncio.wait_for(drone.mission.start_mission(), 5.0)
                            resumed = True
                            resume_north = detector.history[-1]["north_progress_m"] if detector.history else held_north
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

            sample = detector.record_sample(
                lat=pos.latitude_deg,
                lon=pos.longitude_deg,
                rel_alt=pos.relative_altitude_m,
                speed_m_s=vel.north_m_s,
                elapsed_s=elapsed,
                iso_timestamp=iso_now,
            )

            emit_interactive("telemetry", {
                "timestamp": iso_now,
                "lat": pos.latitude_deg,
                "lon": pos.longitude_deg,
                "alt_m": pos.relative_altitude_m,
                "speed_m_s": speed_3d,
                "north_speed_m_s": vel.north_m_s,
                "north_progress_m": sample["north_progress_m"],
                "is_moving": sample["is_moving"],
                "confirmed": sample["confirmed"],
            })

            # 1. First motion confirmation
            if sample["confirmed"] and not motion_confirmed:
                motion_confirmed = True
                emit_interactive("event", {"label": "Route motion confirmed"})

            # 2. Blockage injection & Hold request
            if motion_confirmed and not hold_requested and sample["north_progress_m"] >= 5.0:
                boundary = 20.0
                if sample["north_progress_m"] >= boundary:
                    raise MotionTimeoutError("Simulator reached blocked segment before injection.")
                hold_requested = True
                blocked = True
                emit_interactive("blockage", {"blocked": True, "boundary_m": boundary})
                emit_interactive("event", {"label": "Next segment blocked"})
                emit_interactive("hold_requested", {"hold_requested": True})
                emit_interactive("event", {"label": "Autopilot commanded hold"})

                async def pause_mission() -> None:
                    async with asyncio.timeout(5):
                        await drone.mission.pause_mission()

                pause_task = asyncio.create_task(pause_mission())

            # 3. Confirming hold
            if hold_requested and not hold_confirmed:
                if sample["north_progress_m"] >= 20.0:
                    raise MotionTimeoutError(f"Simulator entered blocked segment at {sample['north_progress_m']:.2f} m.")
                if pause_task and pause_task.done():
                    await pause_task
                    if speed_3d > 0.5:
                        stopped_since = None
                    elif stopped_since is None:
                        stopped_since = now
                    elif now - stopped_since >= 1.0:
                        hold_confirmed = True
                        held_north = sample["north_progress_m"]
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
                    emit_interactive("blockage", {"blocked": False})
                    emit_interactive("event", {"label": "Blockage cleared"})
                    emit_interactive("event", {"label": "Telemetry confirmed continued hold for two seconds after clearance"})

            # Check hold integrity (no drift without resume)
            if hold_confirmed and not resumed:
                if speed_3d > 0.75 or abs(sample["north_progress_m"] - held_north) > 1.0:
                    raise MotionTimeoutError(f"Simulator moved after hold without explicit resume (speed {speed_3d:.2f} m/s).")

            # 5. Motion after explicit resume
            if resumed and not resumed_motion_confirmed:
                if sample["north_progress_m"] >= resume_north + 2.0 and vel.north_m_s >= 0.5:
                    resumed_motion_confirmed = True
                    emit_interactive("event", {"label": "Route motion resumed"})
                    emit_interactive("phase", {"phase": "running"})

            # In interactive mode, if scenario finished, wait for operator end or motion timeout
            if resumed_motion_confirmed:
                if now - flight_start > motion_timeout:
                    emit_interactive("event", {"label": "Simulation completed synthetic route flight"})
                    emit_interactive("phase", {"phase": "ended"})
                    return True

            if not motion_confirmed and elapsed > motion_timeout:
                raise MotionTimeoutError(f"Motion along route could not be confirmed within timeout {motion_timeout}s.")

    finally:
        await cleanup_drone(drone)
