"""
Unit tests for SIM-1 Interactive Runner & Shared Utilities:
Tests JSON-line emissions, interactive command processing (resume, end),
rejection of invalid resumes (not holding, blocked, stale telemetry),
max runtime bound, shared startup helper, and drone cleanup.
"""

import asyncio
import io
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from scripts.sim1_shared import (
    MotionDetector,
    MotionTimeoutError,
    SafetyViolationError,
    SimulatorError,
    StartupTimeoutError,
    build_route_legs,
    cleanup_drone,
    emit_interactive,
    sim1_startup,
)
from scripts.sim1_interactive import run_sim1_interactive


class TestInteractiveEmitter(unittest.TestCase):
    def test_emit_interactive_writes_valid_json_line(self) -> None:
        captured = io.StringIO()
        with patch("sys.stdout", captured):
            emit_interactive("phase", {"phase": "running"})
            emit_interactive("event", {"label": "Test event"})

        lines = captured.getvalue().strip().split("\n")
        self.assertEqual(len(lines), 2)
        p1 = json.loads(lines[0])
        p2 = json.loads(lines[1])
        self.assertEqual(p1, {"type": "phase", "phase": "running"})
        self.assertEqual(p2, {"type": "event", "label": "Test event"})


class TestSharedDroneHelpers(unittest.IsolatedAsyncioTestCase):
    async def test_cleanup_drone_handles_none_and_methods(self) -> None:
        # None drone
        await cleanup_drone(None)

        # Mock drone with async stop server and kill process
        mock_drone = AsyncMock()
        mock_drone._stop_mavsdk_server = AsyncMock()
        mock_proc = AsyncMock()
        mock_proc.kill = AsyncMock()
        mock_drone._server_process = mock_proc

        await cleanup_drone(mock_drone)
        mock_drone._stop_mavsdk_server.assert_awaited_once()
        mock_proc.kill.assert_awaited_once()

    async def test_sim1_startup_success(self) -> None:
        mock_drone = AsyncMock()
        mock_drone.connect = AsyncMock()
        mock_drone.action = AsyncMock()
        mock_drone.mission = AsyncMock()

        async def conn_stream():
            yield SimpleNamespace(is_connected=True)

        async def health_stream():
            yield SimpleNamespace(is_armable=True, is_global_position_ok=True, is_home_position_ok=True)

        async def pos_stream():
            yield SimpleNamespace(latitude_deg=47.397743, longitude_deg=8.545594, relative_altitude_m=10.0)

        mock_drone.core = SimpleNamespace(connection_state=conn_stream)
        mock_drone.telemetry = SimpleNamespace(health=health_stream, position=pos_stream)

        events: list[str] = []
        with patch("scripts.sim1_shared.System", return_value=mock_drone):
            drone, pos, items, detector = await sim1_startup(
                address="udpin://127.0.0.1:14540",
                startup_timeout=1.0,
                event_callback=events.append,
            )
            self.assertEqual(drone, mock_drone)
            self.assertAlmostEqual(pos.latitude_deg, 47.397743)
            self.assertEqual(len(items), 3)
            self.assertGreater(len(events), 0)

    async def test_sim1_startup_custom_waypoints_validation(self) -> None:
        mock_drone = AsyncMock()
        mock_drone.connect = AsyncMock()
        mock_drone.action = AsyncMock()
        mock_drone.mission = AsyncMock()

        async def conn_stream():
            yield SimpleNamespace(is_connected=True)

        async def health_stream():
            yield SimpleNamespace(is_armable=True, is_global_position_ok=True, is_home_position_ok=True)

        async def pos_stream():
            yield SimpleNamespace(latitude_deg=47.397743, longitude_deg=8.545594, relative_altitude_m=10.0)

        mock_drone.core = SimpleNamespace(connection_state=conn_stream)
        mock_drone.telemetry = SimpleNamespace(health=health_stream, position=pos_stream)

        # 1. Valid custom waypoints
        valid_wps = [
            {"latitudeDeg": 47.398043, "longitudeDeg": 8.545594, "altitudeM": 15.0},
            {"latitudeDeg": 47.398043, "longitudeDeg": 8.545994, "altitudeM": 15.0},
        ]
        events: list[str] = []
        with patch("scripts.sim1_shared.System", return_value=mock_drone):
            drone, pos, items, detector = await sim1_startup(
                address="udpin://127.0.0.1:14540",
                startup_timeout=1.0,
                event_callback=events.append,
                custom_waypoints=valid_wps,
            )
            self.assertEqual(len(items), 2)
            self.assertTrue(any("2 custom waypoints" in e for e in events))

        # 2. Reject out-of-boundary waypoints (>10km)
        distant_wps = [
            {"latitudeDeg": 37.7749, "longitudeDeg": -122.4194, "altitudeM": 20.0},
            {"latitudeDeg": 37.7759, "longitudeDeg": -122.4184, "altitudeM": 20.0},
        ]
        with patch("scripts.sim1_shared.System", return_value=mock_drone):
            with self.assertRaises(SafetyViolationError):
                await sim1_startup(
                    address="udpin://127.0.0.1:14540",
                    startup_timeout=1.0,
                    custom_waypoints=distant_wps,
                )

        # 3. Reject physically unsupported short initial leg (< 20m)
        short_wps = [
            {"latitudeDeg": 47.397780, "longitudeDeg": 8.545594, "altitudeM": 10.0},
            {"latitudeDeg": 47.397850, "longitudeDeg": 8.545594, "altitudeM": 10.0},
        ]
        with patch("scripts.sim1_shared.System", return_value=mock_drone):
            with self.assertRaises(SimulatorError) as ctx:
                await sim1_startup(
                    address="udpin://127.0.0.1:14540",
                    startup_timeout=1.0,
                    custom_waypoints=short_wps,
                )
            self.assertIn("too short or degenerate", str(ctx.exception))

        # 4. Reject degenerate initial leg (distance = 0)
        degenerate_wps = [
            {"latitudeDeg": 47.397743, "longitudeDeg": 8.545594, "altitudeM": 10.0},
            {"latitudeDeg": 47.397743, "longitudeDeg": 8.545594, "altitudeM": 10.0},
        ]
        with patch("scripts.sim1_shared.System", return_value=mock_drone):
            with self.assertRaises(SimulatorError) as ctx:
                await sim1_startup(
                    address="udpin://127.0.0.1:14540",
                    startup_timeout=1.0,
                    custom_waypoints=degenerate_wps,
                )
            self.assertIn("too short or degenerate", str(ctx.exception))

    def test_motion_detector_horizontal_leg_progress(self) -> None:
        home_lat, home_lon, home_alt = 47.397743, 8.545594, 10.0
        # Eastbound leg: unit vector (0.0, 1.0)
        detector = MotionDetector(
            home_lat=home_lat,
            home_lon=home_lon,
            home_alt=home_alt,
            min_displacement_m=2.0,
            min_speed_m_s=0.5,
            required_samples=3,
            leg_unit=(0.0, 1.0),
        )

        # 1. Pure vertical climb cannot satisfy motion
        climb_sample = detector.record_sample(
            lat=home_lat,
            lon=home_lon,
            rel_alt=30.0,
            speed_m_s=4.0,
            elapsed_s=1.0,
            vel_north_m_s=0.0,
            vel_east_m_s=0.0,
        )
        self.assertAlmostEqual(climb_sample["progress_m"], 0.0)
        self.assertFalse(climb_sample["is_moving"])
        self.assertFalse(climb_sample["confirmed"])

        # 2. Pure northward drift perpendicular to eastbound leg cannot satisfy motion
        drift_sample = detector.record_sample(
            lat=home_lat + 0.000300,
            lon=home_lon,
            rel_alt=home_alt,
            speed_m_s=3.0,
            elapsed_s=2.0,
            vel_north_m_s=3.0,
            vel_east_m_s=0.0,
        )
        self.assertAlmostEqual(drift_sample["progress_m"], 0.0)
        self.assertFalse(drift_sample["is_moving"])

        # 3. Horizontal along-leg eastbound motion satisfies progress and motion confirmation
        for i in range(3):
            east_sample = detector.record_sample(
                lat=home_lat,
                lon=home_lon + 0.000100 * (i + 1),
                rel_alt=home_alt,
                speed_m_s=2.0,
                elapsed_s=3.0 + i,
                vel_north_m_s=0.0,
                vel_east_m_s=2.0,
            )
            self.assertTrue(east_sample["progress_m"] >= 2.0)
            self.assertTrue(east_sample["is_moving"])
        self.assertTrue(detector.is_confirmed)


class TestInteractiveRunnerBehavior(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.stdout_buf = io.StringIO()
        self.stdout_patcher = patch("sys.stdout", self.stdout_buf)
        self.stdout_patcher.start()

    def tearDown(self) -> None:
        self.stdout_patcher.stop()

    def get_emitted_messages(self) -> list[dict]:
        output = self.stdout_buf.getvalue()
        messages = []
        for line in output.strip().split("\n"):
            line = line.strip()
            if line and line.startswith("{"):
                try:
                    messages.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        return messages

    async def test_rejects_unsafe_address(self) -> None:
        with self.assertRaises(SafetyViolationError):
            await run_sim1_interactive("udp://192.168.1.50:14540")

    async def test_reports_startup_timeout(self) -> None:
        mock_system = AsyncMock()
        mock_system.connect = AsyncMock(side_effect=asyncio.TimeoutError())
        with patch("scripts.sim1_shared.System", return_value=mock_system):
            with self.assertRaises(StartupTimeoutError):
                await run_sim1_interactive("udpin://127.0.0.1:14540", startup_timeout=0.01)

    async def test_end_command_terminates_session(self) -> None:
        # Mock stdin with {"command": "end"}
        mock_stdin = io.StringIO(json.dumps({"command": "end"}) + "\n")

        mock_drone = AsyncMock()
        mock_drone.connect = AsyncMock()
        mock_drone.action = AsyncMock()
        mock_drone.mission = AsyncMock()

        async def conn_stream():
            yield SimpleNamespace(is_connected=True)

        async def health_stream():
            yield SimpleNamespace(is_armable=True, is_global_position_ok=True, is_home_position_ok=True)

        async def pos_stream():
            while True:
                yield SimpleNamespace(latitude_deg=47.397743, longitude_deg=8.545594, relative_altitude_m=10.0)

        async def vel_stream():
            while True:
                yield SimpleNamespace(north_m_s=1.0, east_m_s=0.0, down_m_s=0.0)

        mock_drone.core = SimpleNamespace(connection_state=conn_stream)
        mock_drone.telemetry = SimpleNamespace(
            health=health_stream,
            position=pos_stream,
            velocity_ned=vel_stream,
        )

        with patch("sys.stdin", mock_stdin):
            with patch("scripts.sim1_shared.System", return_value=mock_drone):
                result = await run_sim1_interactive(
                    "udpin://127.0.0.1:14540", startup_timeout=1.0, motion_timeout=5.0
                )
                self.assertTrue(result)

        messages = self.get_emitted_messages()
        phases = [m.get("phase") for m in messages if m.get("type") == "phase"]
        self.assertIn("starting", phases)
        self.assertIn("ended", phases)

    async def test_bounds_max_runtime(self) -> None:
        mock_stdin = io.StringIO()
        mock_drone = AsyncMock()
        mock_drone.connect = AsyncMock()
        mock_drone.action = AsyncMock()
        mock_drone.mission = AsyncMock()

        async def conn_stream():
            yield SimpleNamespace(is_connected=True)

        async def health_stream():
            yield SimpleNamespace(is_armable=True, is_global_position_ok=True, is_home_position_ok=True)

        async def pos_stream():
            while True:
                yield SimpleNamespace(latitude_deg=47.397743, longitude_deg=8.545594, relative_altitude_m=10.0)

        async def vel_stream():
            while True:
                yield SimpleNamespace(north_m_s=1.0, east_m_s=0.0, down_m_s=0.0)

        mock_drone.core = SimpleNamespace(connection_state=conn_stream)
        mock_drone.telemetry = SimpleNamespace(
            health=health_stream,
            position=pos_stream,
            velocity_ned=vel_stream,
        )

        with patch("sys.stdin", mock_stdin):
            with patch("scripts.sim1_shared.System", return_value=mock_drone):
                with self.assertRaises(MotionTimeoutError) as ctx:
                    # Very short max_runtime (0.01s)
                    await run_sim1_interactive(
                        "udpin://127.0.0.1:14540",
                        startup_timeout=1.0,
                        motion_timeout=5.0,
                        max_runtime=0.01,
                    )
                self.assertIn("maximum bounded lifetime", str(ctx.exception))

    async def test_hold_settling_backward_overshoot_does_not_fail(self) -> None:
        """
        Verify that when a drone pauses, overshoots during braking flare,
        and settles backward by ~1.0m to its loiter setpoint at hover speed,
        the hold integrity check accommodates settling without false trigger.
        """
        mock_stdin = io.StringIO()

        mock_drone = AsyncMock()
        mock_drone.connect = AsyncMock()
        mock_drone.action = AsyncMock()
        mock_drone.mission = AsyncMock()
        mock_drone.mission.pause_mission = AsyncMock()

        async def conn_stream():
            yield SimpleNamespace(is_connected=True)

        async def health_stream():
            yield SimpleNamespace(is_armable=True, is_global_position_ok=True, is_home_position_ok=True)

        lat_base = 47.397743
        lon_base = 8.545594

        profile = [
            (0.0, 0.0),
            (0.0, 0.0),
            (2.5, 2.0),
            (3.5, 3.0),
            (4.5, 3.5),
            (5.5, 3.5),
            (8.0, 1.5),
            (10.5, 0.2), # sub-0.5 and sub-0.25 (sample 1)
            (10.5, 0.2), # sample 2
            (10.5, 0.2), # sample 3
            (10.5, 0.2), # sample 4 -> hold confirmed (initial=10.5m)
            (10.2, -0.2),
            (9.9, -0.2),
            (9.6, -0.1),
            (9.5, 0.0),  # settled at 9.5m (delta -1.0m)
            (9.5, 0.0),
            (9.5, 0.0),
        ]

        step = 0
        def make_pos_stream():
            async def pos_stream():
                curr_idx = min(step, len(profile) - 1)
                north_m = profile[curr_idx][0]
                lat = lat_base + (north_m / 111320.0)
                yield SimpleNamespace(latitude_deg=lat, longitude_deg=lon_base, relative_altitude_m=10.0)
            return pos_stream()

        def make_vel_stream():
            async def vel_stream():
                nonlocal step
                curr_idx = min(step, len(profile) - 1)
                vn = profile[curr_idx][1]
                step += 1
                yield SimpleNamespace(north_m_s=vn, east_m_s=0.0, down_m_s=0.0)
            return vel_stream()

        mock_drone.core = SimpleNamespace(connection_state=conn_stream)
        mock_drone.telemetry = SimpleNamespace(
            health=health_stream,
            position=make_pos_stream,
            velocity_ned=make_vel_stream,
        )

        with patch("sys.stdin", mock_stdin):
            with patch("scripts.sim1_shared.System", return_value=mock_drone):
                with self.assertRaises(MotionTimeoutError) as ctx:
                    await run_sim1_interactive(
                        "udpin://127.0.0.1:14540",
                        startup_timeout=1.0,
                        motion_timeout=5.0,
                        max_runtime=6.0,
                    )
                self.assertIn("maximum bounded lifetime", str(ctx.exception))

        messages = self.get_emitted_messages()
        events = [m.get("label") for m in messages if m.get("type") == "event"]
        self.assertIn("Route motion confirmed", events)
        self.assertIn("Autopilot commanded hold", events)
        self.assertIn("Telemetry confirmed hold", events)
        errors = [m for m in messages if m.get("type") == "error"]
        self.assertEqual(errors, [])

    async def test_genuine_unintended_forward_movement_after_hold_fails(self) -> None:
        """
        Verify that genuine uncommanded forward motion along the route leg after hold
        is detected and rejected.
        """
        mock_stdin = io.StringIO()

        mock_drone = AsyncMock()
        mock_drone.connect = AsyncMock()
        mock_drone.action = AsyncMock()
        mock_drone.mission = AsyncMock()
        mock_drone.mission.pause_mission = AsyncMock()

        async def conn_stream():
            yield SimpleNamespace(is_connected=True)

        async def health_stream():
            yield SimpleNamespace(is_armable=True, is_global_position_ok=True, is_home_position_ok=True)

        lat_base = 47.397743
        lon_base = 8.545594

        profile = [
            (0.0, 0.0),
            (0.0, 0.0),
            (2.5, 2.0),
            (3.5, 3.0),
            (4.5, 3.5),
            (5.5, 3.5),  # hold requested
            (8.0, 2.0),
            (10.0, 0.3), # sample 1 (t=0)
            (10.0, 0.25),# sample 2 (t=0.35s)
            (10.0, 0.2), # sample 3 (t=0.70s)
            (10.0, 0.2), # sample 4 (t=1.05s -> hold confirmed, held=10.0)
            (9.5, -0.1), # settles to 9.5m (held updates to 9.5)
            (9.5, 0.0),
            (10.8, 0.6), # uncommanded forward surge to 10.8m (+1.3m > 1.0m)
            (10.8, 0.6),
        ]

        step = 0
        def make_pos_stream():
            async def pos_stream():
                curr_idx = min(step, len(profile) - 1)
                north_m = profile[curr_idx][0]
                lat = lat_base + (north_m / 111320.0)
                yield SimpleNamespace(latitude_deg=lat, longitude_deg=lon_base, relative_altitude_m=10.0)
            return pos_stream()

        def make_vel_stream():
            async def vel_stream():
                nonlocal step
                curr_idx = min(step, len(profile) - 1)
                vn = profile[curr_idx][1]
                step += 1
                yield SimpleNamespace(north_m_s=vn, east_m_s=0.0, down_m_s=0.0)
            return vel_stream()

        mock_drone.core = SimpleNamespace(connection_state=conn_stream)
        mock_drone.telemetry = SimpleNamespace(
            health=health_stream,
            position=make_pos_stream,
            velocity_ned=make_vel_stream,
        )

        with patch("sys.stdin", mock_stdin):
            with patch("scripts.sim1_shared.System", return_value=mock_drone):
                with self.assertRaises(MotionTimeoutError) as ctx:
                    await run_sim1_interactive(
                        "udpin://127.0.0.1:14540",
                        startup_timeout=1.0,
                        motion_timeout=10.0,
                        max_runtime=10.0,
                    )
                self.assertIn("Simulator moved after hold without explicit resume", str(ctx.exception))

    async def test_genuine_unintended_high_speed_after_hold_fails(self) -> None:
        """
        Verify that active propulsion (speed > 0.75 m/s) without explicit resume
        is detected and rejected.
        """
        mock_stdin = io.StringIO()

        mock_drone = AsyncMock()
        mock_drone.connect = AsyncMock()
        mock_drone.action = AsyncMock()
        mock_drone.mission = AsyncMock()
        mock_drone.mission.pause_mission = AsyncMock()

        async def conn_stream():
            yield SimpleNamespace(is_connected=True)

        async def health_stream():
            yield SimpleNamespace(is_armable=True, is_global_position_ok=True, is_home_position_ok=True)

        lat_base = 47.397743
        lon_base = 8.545594

        profile = [
            (0.0, 0.0),
            (0.0, 0.0),
            (2.5, 2.0),
            (3.5, 3.0),
            (4.5, 3.5),
            (5.5, 3.5),  # hold requested
            (8.0, 2.0),
            (10.0, 0.3), # sample 1
            (10.0, 0.25),# sample 2
            (10.0, 0.2), # sample 3
            (10.0, 0.2), # sample 4 -> hold confirmed
            (9.5, -0.1),
            (9.5, 0.85), # speed surge > 0.75 m/s
            (9.5, 0.85),
        ]

        step = 0
        def make_pos_stream():
            async def pos_stream():
                curr_idx = min(step, len(profile) - 1)
                north_m = profile[curr_idx][0]
                lat = lat_base + (north_m / 111320.0)
                yield SimpleNamespace(latitude_deg=lat, longitude_deg=lon_base, relative_altitude_m=10.0)
            return pos_stream()

        def make_vel_stream():
            async def vel_stream():
                nonlocal step
                curr_idx = min(step, len(profile) - 1)
                vn = profile[curr_idx][1]
                step += 1
                yield SimpleNamespace(north_m_s=vn, east_m_s=0.0, down_m_s=0.0)
            return vel_stream()

        mock_drone.core = SimpleNamespace(connection_state=conn_stream)
        mock_drone.telemetry = SimpleNamespace(
            health=health_stream,
            position=make_pos_stream,
            velocity_ned=make_vel_stream,
        )

        with patch("sys.stdin", mock_stdin):
            with patch("scripts.sim1_shared.System", return_value=mock_drone):
                with self.assertRaises(MotionTimeoutError) as ctx:
                    await run_sim1_interactive(
                        "udpin://127.0.0.1:14540",
                        startup_timeout=1.0,
                        motion_timeout=10.0,
                        max_runtime=10.0,
                    )
                self.assertIn("Simulator moved after hold without explicit resume", str(ctx.exception))

    async def test_excessive_backward_drift_after_hold_fails(self) -> None:
        """
        Verify that excessive runaway drift (> 2.0m backward) is detected and rejected.
        """
        mock_stdin = io.StringIO()

        mock_drone = AsyncMock()
        mock_drone.connect = AsyncMock()
        mock_drone.action = AsyncMock()
        mock_drone.mission = AsyncMock()
        mock_drone.mission.pause_mission = AsyncMock()

        async def conn_stream():
            yield SimpleNamespace(is_connected=True)

        async def health_stream():
            yield SimpleNamespace(is_armable=True, is_global_position_ok=True, is_home_position_ok=True)

        lat_base = 47.397743
        lon_base = 8.545594

        profile = [
            (0.0, 0.0),
            (0.0, 0.0),
            (2.5, 2.0),
            (3.5, 3.0),
            (4.5, 3.5),
            (5.5, 3.5),  # hold requested
            (8.0, 1.5),
            (10.0, 0.2), # sample 1 (speed <= 0.5 and leg <= 0.25)
            (10.0, 0.2), # sample 2
            (10.0, 0.2), # sample 3
            (10.0, 0.2), # sample 4 -> hold confirmed (initial=10.0m)
            (9.0, -0.3),
            (7.0, -0.3), # drifted backward to 7.0m (drift = 3.0m > 2.0m)
            (7.0, -0.3),
        ]

        step = 0
        def make_pos_stream():
            async def pos_stream():
                curr_idx = min(step, len(profile) - 1)
                north_m = profile[curr_idx][0]
                lat = lat_base + (north_m / 111320.0)
                yield SimpleNamespace(latitude_deg=lat, longitude_deg=lon_base, relative_altitude_m=10.0)
            return pos_stream()

        def make_vel_stream():
            async def vel_stream():
                nonlocal step
                curr_idx = min(step, len(profile) - 1)
                vn = profile[curr_idx][1]
                step += 1
                yield SimpleNamespace(north_m_s=vn, east_m_s=0.0, down_m_s=0.0)
            return vel_stream()

        mock_drone.core = SimpleNamespace(connection_state=conn_stream)
        mock_drone.telemetry = SimpleNamespace(
            health=health_stream,
            position=make_pos_stream,
            velocity_ned=make_vel_stream,
        )

        with patch("sys.stdin", mock_stdin):
            with patch("scripts.sim1_shared.System", return_value=mock_drone):
                with self.assertRaises(MotionTimeoutError) as ctx:
                    await run_sim1_interactive(
                        "udpin://127.0.0.1:14540",
                        startup_timeout=1.0,
                        motion_timeout=10.0,
                        max_runtime=10.0,
                    )
                self.assertIn("Simulator drifted excessively after hold", str(ctx.exception))

    async def test_target_leg_insufficient_distance_raises_error(self) -> None:
        """Verify error raised when selected target leg has insufficient room for hold & boundary."""
        short_wps = [
            {"latitudeDeg": 47.398043, "longitudeDeg": 8.545594, "altitudeM": 10.0},
            {"latitudeDeg": 47.398343, "longitudeDeg": 8.545594, "altitudeM": 10.0},
            {"latitudeDeg": 47.398343, "longitudeDeg": 8.545700, "altitudeM": 10.0}, # ~8m leg
            {"latitudeDeg": 47.398043, "longitudeDeg": 8.545700, "altitudeM": 10.0},
        ]
        mock_drone = AsyncMock()
        mock_drone.connect = AsyncMock()
        mock_drone.action = AsyncMock()
        mock_drone.mission = AsyncMock()

        async def conn_stream():
            yield SimpleNamespace(is_connected=True)

        async def health_stream():
            yield SimpleNamespace(is_armable=True, is_global_position_ok=True, is_home_position_ok=True)

        async def pos_stream():
            yield SimpleNamespace(latitude_deg=47.397743, longitude_deg=8.545594, relative_altitude_m=10.0)

        mock_drone.core = SimpleNamespace(connection_state=conn_stream)
        mock_drone.telemetry = SimpleNamespace(
            health=health_stream,
            position=pos_stream,
        )

        with patch("scripts.sim1_shared.System", return_value=mock_drone):
            with self.assertRaises(SimulatorError) as ctx:
                await run_sim1_interactive(
                    "udpin://127.0.0.1:14540",
                    startup_timeout=1.0,
                    custom_waypoints=short_wps,
                    block_leg=1, # Target leg 2 (distance ~8m < 25m)
                    block_boundary=20.0,
                )
            self.assertIn("insufficient", str(ctx.exception).lower())

    async def test_multi_leg_turn_hold_resume_and_completion_lifecycle(self) -> None:
        """
        Verify complete multi-leg journey in runner:
        Leg 1 (North) -> 90° turn -> Leg 2 (East) with hold, clear, explicit resume -> Leg 3 (South) -> completed.
        """
        import queue

        class DynamicStdin:
            def __init__(self):
                self._q = queue.Queue()

            def put(self, text: str):
                self._q.put(text)

            def close(self):
                self._q.put(None)

            def readline(self):
                item = self._q.get()
                return "" if item is None else item

            def __iter__(self):
                while True:
                    line = self.readline()
                    if not line:
                        break
                    yield line

        dynamic_stdin = DynamicStdin()

        four_wps = [
            {"id": "wp-1", "latitudeDeg": 47.398043, "longitudeDeg": 8.545594, "altitudeM": 10.0},
            {"id": "wp-2", "latitudeDeg": 47.398343, "longitudeDeg": 8.545594, "altitudeM": 10.0},
            {"id": "wp-3", "latitudeDeg": 47.398343, "longitudeDeg": 8.546094, "altitudeM": 10.0},
            {"id": "wp-4", "latitudeDeg": 47.398043, "longitudeDeg": 8.546094, "altitudeM": 10.0},
        ]

        mock_drone = AsyncMock()
        mock_drone.connect = AsyncMock()
        mock_drone.action = AsyncMock()
        mock_drone.mission = AsyncMock()
        mock_drone.mission.pause_mission = AsyncMock()
        mock_drone.mission.start_mission = AsyncMock()

        async def conn_stream():
            yield SimpleNamespace(is_connected=True)

        async def health_stream():
            yield SimpleNamespace(is_armable=True, is_global_position_ok=True, is_home_position_ok=True)

        step_idx = 0

        # Mission progress stream:
        # progresses from item 0 -> item 1 (Leg 1) -> item 2 (Leg 2) -> item 3 (Leg 3) -> item 4 (completed)
        async def prog_stream():
            yield SimpleNamespace(current=0, total=4)
            while step_idx < 5:
                await asyncio.sleep(0.05)
            yield SimpleNamespace(current=1, total=4) # WP1 -> WP2 (Leg 0)
            while step_idx < 7:
                await asyncio.sleep(0.05)
            yield SimpleNamespace(current=2, total=4) # WP2 -> WP3 (Leg 1)
            while step_idx < 22:
                await asyncio.sleep(0.05)
            yield SimpleNamespace(current=3, total=4) # WP3 -> WP4 (Leg 2)
            while step_idx < 25:
                await asyncio.sleep(0.05)
            yield SimpleNamespace(current=4, total=4) # Finished

        mock_drone.core = SimpleNamespace(connection_state=conn_stream)
        mock_drone.mission.mission_progress = prog_stream

        async def mock_is_finished():
            return step_idx >= 25

        mock_drone.mission.is_mission_finished = mock_is_finished

        # Telemetry position and velocity profile
        lat_base = 47.397743
        lon_base = 8.545594

        telemetry_steps = [
            # Takeoff from Home:
            (47.397743, 8.545594, 0.0, 0.0),
            (47.397788, 8.545594, 2.0, 0.0), # sample 1 moving
            (47.397833, 8.545594, 3.0, 0.0), # sample 2 moving
            (47.397878, 8.545594, 3.5, 0.0), # sample 3 moving -> confirmed!
            (47.398043, 8.545594, 3.5, 0.0), # WP 1
            # Leg 1 (Northward from WP 1 to WP 2):
            (47.398143, 8.545594, 3.5, 0.0),
            (47.398343, 8.545594, 2.0, 0.0), # WP 2
            # Leg 2 (Eastward from WP 2 to WP 3) - Turn 90°!
            (47.398343, 8.545644, 0.0, 2.0),
            (47.398343, 8.545720, 0.0, 3.0), # Triggers hold!
            (47.398343, 8.545750, 0.0, 0.2), # Decel
            (47.398343, 8.545750, 0.0, 0.1), # Stopped 1
            (47.398343, 8.545750, 0.0, 0.05),# Stopped 2
            (47.398343, 8.545750, 0.0, 0.0), # Stopped 3 -> Hold confirmed! (t=0)
            (47.398343, 8.545750, 0.0, 0.0), # t=0.35s
            (47.398343, 8.545750, 0.0, 0.0), # t=0.70s
            (47.398343, 8.545750, 0.0, 0.0), # t=1.05s
            (47.398343, 8.545750, 0.0, 0.0), # t=1.40s
            (47.398343, 8.545750, 0.0, 0.0), # t=1.75s
            (47.398343, 8.545750, 0.0, 0.0), # t=2.10s -> Blockage cleared!
            (47.398343, 8.545750, 0.0, 0.0), # Continued hold after clearance
            (47.398343, 8.545750, 0.0, 0.0), # Continued hold after clearance
            # Explicit resume commanded here!
            (47.398343, 8.545800, 0.0, 2.5),
            (47.398343, 8.545850, 0.0, 3.5), # Resumed motion confirmed!
            (47.398343, 8.546094, 0.0, 2.0), # WP 3
            # Leg 3 (Southward from WP 3 to WP 4) - Turn 90°!
            (47.398200, 8.546094, -3.0, 0.0),
            (47.398043, 8.546094, 0.0, 0.0), # WP 4 Completed!
        ]

        def make_pos_stream():
            async def pos_stream():
                curr = min(step_idx, len(telemetry_steps) - 1)
                lat, lon, _, _ = telemetry_steps[curr]
                yield SimpleNamespace(latitude_deg=lat, longitude_deg=lon, relative_altitude_m=10.0)
            return pos_stream()

        resume_sent = False
        end_sent = False

        def make_vel_stream():
            async def vel_stream():
                nonlocal step_idx, resume_sent, end_sent
                curr = min(step_idx, len(telemetry_steps) - 1)
                _, _, vn, ve = telemetry_steps[curr]
                step_idx += 1

                if step_idx >= 21 and not resume_sent:
                    resume_sent = True
                    dynamic_stdin.put(json.dumps({"command": "resume"}) + "\n")
                if step_idx >= 25 and not end_sent:
                    end_sent = True
                    dynamic_stdin.put(json.dumps({"command": "end"}) + "\n")

                yield SimpleNamespace(north_m_s=vn, east_m_s=ve, down_m_s=0.0)
            return vel_stream()

        mock_drone.telemetry = SimpleNamespace(
            health=health_stream,
            position=make_pos_stream,
            velocity_ned=make_vel_stream,
        )

        try:
            with patch("sys.stdin", dynamic_stdin):
                with patch("scripts.sim1_shared.System", return_value=mock_drone):
                    result = await run_sim1_interactive(
                        "udpin://127.0.0.1:14540",
                        startup_timeout=1.0,
                        motion_timeout=10.0,
                        max_runtime=15.0,
                        custom_waypoints=four_wps,
                        block_leg=1, # Leg 2 (WP 2 -> WP 3)
                        hold_trigger=5.0,
                        block_boundary=20.0,
                    )
                    self.assertTrue(result)
        finally:
            dynamic_stdin.close()

        messages = self.get_emitted_messages()
        phases = [m.get("phase") for m in messages if m.get("type") == "phase"]
        self.assertIn("starting", phases)
        self.assertIn("running", phases)
        self.assertIn("holding", phases)
        self.assertIn("completed", phases)
        self.assertIn("ended", phases)

        events = [m.get("label") for m in messages if m.get("type") == "event"]
        self.assertIn("Route motion confirmed", events)
        self.assertIn("Autopilot commanded hold", events)
        self.assertIn("Telemetry confirmed hold", events)
        self.assertIn("Blockage cleared", events)
        self.assertIn("Explicit resume commanded", events)
        self.assertIn("Route motion resumed", events)
        self.assertIn("Mission completed: reached final waypoint", events)
        self.assertIn("Simulation teardown requested", events)

        # Check leg emissions
        leg_msgs = [m for m in messages if m.get("type") == "leg"]
        self.assertTrue(any(l.get("stage") == "leg" and l.get("leg_index") == 1 for l in leg_msgs))
        self.assertTrue(any(l.get("stage") == "completed" for l in leg_msgs))


if __name__ == "__main__":
    unittest.main()
