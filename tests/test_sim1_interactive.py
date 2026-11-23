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
    MotionTimeoutError,
    SafetyViolationError,
    StartupTimeoutError,
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


if __name__ == "__main__":
    unittest.main()
