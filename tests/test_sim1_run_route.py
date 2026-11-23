"""
Unit tests for SIM-1: Autonomous Route Execution and Telemetry Verification.
Tests address safety enforcement, synthetic route generation, displacement calculation,
and motion detector logic.
"""

import math
import unittest
from unittest.mock import MagicMock

# Import components from scripts/sim1_run_route.py
import asyncio
import signal
import subprocess
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from scripts.sim1_run_route import (
    MotionDetector,
    SafetyViolationError,
    calculate_displacement,
    generate_synthetic_route,
    validate_safe_address,
    verify_blocked_hold,
    verify_clear_and_resume,
    resume_if_clear,
    remove_simulator_containers,
    SimulatorError,
    MotionTimeoutError,
)


class TestSim1SafetyGuards(unittest.TestCase):
    """Test safety enforcement blocking real hardware and remote networks."""

    def test_allowed_loopback_addresses(self) -> None:
        valid_addresses = [
            "udpin://127.0.0.1:14540",
            "udp://127.0.0.1:14540",
            "udp://localhost:14540",
            "tcp://127.0.0.1:5760",
            "tcp://localhost:5760",
        ]
        for addr in valid_addresses:
            with self.subTest(address=addr):
                try:
                    validate_safe_address(addr)
                except SafetyViolationError:
                    self.fail(f"validate_safe_address incorrectly rejected safe address: {addr}")

    def test_forbidden_hardware_interfaces(self) -> None:
        hardware_addresses = [
            "/dev/ttyUSB0",
            "/dev/tty.usbmodem14101",
            "/dev/cu.usbserial-10",
            "serial:///dev/ttyACM0:57600",
            "COM3",
            "COM1",
            "usb://device/1",
            "bluetooth://00:11:22:33:44:55",
        ]
        for addr in hardware_addresses:
            with self.subTest(address=addr):
                with self.assertRaises(SafetyViolationError, msg=f"Should reject hardware address: {addr}"):
                    validate_safe_address(addr)

    def test_forbidden_remote_addresses(self) -> None:
        remote_addresses = [
            "udpin://0.0.0.0:14540",
            "udp://:14540",
            "udp://localhost:65536",
            "udp://192.168.1.50:14540",
            "udp://10.0.0.1:14540",
            "tcp://172.16.0.2:5760",
            "udp://drone.lan:14540",
            "http://127.0.0.1:14540",
            "",
            "   ",
        ]
        for addr in remote_addresses:
            with self.subTest(address=addr):
                with self.assertRaises(SafetyViolationError, msg=f"Should reject remote address: {addr}"):
                    validate_safe_address(addr)


class TestSim1RouteGeneration(unittest.TestCase):
    """Test fixed benign synthetic waypoint route generation."""

    def test_synthetic_route_structure(self) -> None:
        home_lat = 47.397743
        home_lon = 8.545594
        alt_m = 10.0
        speed_m_s = 4.0

        items = generate_synthetic_route(home_lat, home_lon, alt_m=alt_m, speed_m_s=speed_m_s)
        self.assertEqual(len(items), 3, "Expected 3 synthetic waypoints forming benign pattern")

        # Check waypoints exist and are within ~50 meters of home
        for wp in items:
            if hasattr(wp, "latitude_deg"):
                lat = wp.latitude_deg
                lon = wp.longitude_deg
                alt = wp.relative_altitude_m
                speed = wp.speed_m_s
            else:
                lat = wp["latitude_deg"]
                lon = wp["longitude_deg"]
                alt = wp["relative_altitude_m"]
                speed = wp["speed_m_s"]

            self.assertEqual(alt, alt_m)
            self.assertEqual(speed, speed_m_s)
            _, _, _, dist = calculate_displacement(home_lat, home_lon, 0.0, lat, lon, 0.0)
            self.assertGreater(dist, 10.0, "Waypoint should be separated from home")
            self.assertLess(dist, 100.0, "Waypoint must remain in benign local vicinity (<100m)")


class TestSim1Displacement(unittest.TestCase):
    """Test 3D displacement calculation."""

    def test_zero_displacement(self) -> None:
        dn, de, du, dist = calculate_displacement(47.0, 8.0, 10.0, 47.0, 8.0, 10.0)
        self.assertAlmostEqual(dist, 0.0, places=3)
        self.assertAlmostEqual(dn, 0.0, places=3)
        self.assertAlmostEqual(de, 0.0, places=3)
        self.assertAlmostEqual(du, 0.0, places=3)

    def test_vertical_only_displacement(self) -> None:
        _, _, du, dist = calculate_displacement(47.0, 8.0, 0.0, 47.0, 8.0, 15.0)
        self.assertAlmostEqual(du, 15.0, places=3)
        self.assertAlmostEqual(dist, 15.0, places=3)

    def test_horizontal_displacement(self) -> None:
        # Move ~111m North (0.001 deg lat)
        dn, _, _, dist = calculate_displacement(47.0, 8.0, 0.0, 47.001, 8.0, 0.0)
        self.assertAlmostEqual(dn, 111.32, delta=1.0)
        self.assertAlmostEqual(dist, 111.32, delta=1.0)


class TestSim1MotionDetector(unittest.TestCase):
    """Test motion detector state machine."""

    def setUp(self) -> None:
        self.detector = MotionDetector(
            home_lat=47.397743,
            home_lon=8.545594,
            home_alt=0.0,
            min_displacement_m=2.0,
            min_speed_m_s=0.5,
            required_samples=3,
        )

    def test_stationary_samples_do_not_confirm_motion(self) -> None:
        for i in range(10):
            sample = self.detector.record_sample(
                lat=47.397743,
                lon=8.545594,
                rel_alt=0.01,
                speed_m_s=0.02,
                elapsed_s=float(i) * 0.5,
            )
            self.assertFalse(sample["is_moving"])
            self.assertFalse(sample["confirmed"])
        self.assertFalse(self.detector.is_confirmed)

    def test_vertical_takeoff_does_not_confirm_route_motion(self) -> None:
        for altitude in (3.0, 4.0, 5.0):
            sample = self.detector.record_sample(47.397743, 8.545594, altitude, 1.5, altitude)
            self.assertFalse(sample["is_moving"])
        self.assertFalse(self.detector.is_confirmed)

    def test_moving_samples_confirm_motion_after_required_count(self) -> None:
        # Feed 2 moving samples (not yet confirmed)
        s1 = self.detector.record_sample(
            lat=47.397770, lon=8.545594, rel_alt=3.0, speed_m_s=1.2, elapsed_s=1.0
        )
        self.assertTrue(s1["is_moving"])
        self.assertFalse(s1["confirmed"])

        s2 = self.detector.record_sample(
            lat=47.397780, lon=8.545594, rel_alt=4.0, speed_m_s=1.5, elapsed_s=1.5
        )
        self.assertTrue(s2["is_moving"])
        self.assertFalse(s2["confirmed"])

        # 3rd moving sample triggers confirmation
        s3 = self.detector.record_sample(
            lat=47.397790, lon=8.545594, rel_alt=5.0, speed_m_s=1.8, elapsed_s=2.0
        )
        self.assertTrue(s3["is_moving"])
        self.assertTrue(s3["confirmed"])
        self.assertTrue(self.detector.is_confirmed)

    def test_intermittent_pause_resets_streak(self) -> None:
        # 2 moving samples
        self.detector.record_sample(47.397780, 8.545594, 3.0, 1.0, 1.0)
        self.detector.record_sample(47.397780, 8.545594, 3.5, 1.0, 1.5)
        self.assertFalse(self.detector.is_confirmed)

        # 1 stationary sample
        self.detector.record_sample(47.397743, 8.545594, 0.0, 0.0, 2.0)
        self.assertEqual(self.detector.consecutive_moving_samples, 0)
        self.assertFalse(self.detector.is_confirmed)


class TestBlockedHold(unittest.IsolatedAsyncioTestCase):
    async def test_commands_pause_and_confirms_stop_before_boundary(self) -> None:
        pause = AsyncMock()
        drone = SimpleNamespace(mission=SimpleNamespace(pause_mission=pause))
        with patch("scripts.sim1_run_route.route_sample", new=AsyncMock(return_value=(8.0, 0.1, 0.0))):
            self.assertEqual(await verify_blocked_hold(drone, None, 5.0), 8.0)
        pause.assert_awaited_once()

    async def test_fails_if_telemetry_crosses_boundary(self) -> None:
        drone = SimpleNamespace(mission=SimpleNamespace(pause_mission=AsyncMock()))
        with patch("scripts.sim1_run_route.route_sample", new=AsyncMock(return_value=(20.1, 0.1, 0.0))):
            with self.assertRaisesRegex(MotionTimeoutError, "entered blocked segment"):
                await verify_blocked_hold(drone, None, 5.0)


class TestResume(unittest.IsolatedAsyncioTestCase):
    async def test_telemetry_failure_prevents_resume(self) -> None:
        start = AsyncMock()
        drone = SimpleNamespace(mission=SimpleNamespace(start_mission=start))
        with patch("scripts.sim1_run_route.route_sample", new=AsyncMock(side_effect=MotionTimeoutError("no telemetry"))):
            with self.assertRaisesRegex(MotionTimeoutError, "no telemetry"):
                await resume_if_clear(drone, None, asyncio.Event())
        start.assert_not_called()

    async def test_held_vehicle_resumes_once_and_confirms_progress(self) -> None:
        start = AsyncMock()
        drone = SimpleNamespace(mission=SimpleNamespace(start_mission=start))
        blocked = asyncio.Event()
        blocked.set()

        async def sample(*_args):
            return (12.1, 0.8, 0.8) if start.await_count else (10.0, 0.1, 0.0)

        with patch("scripts.sim1_run_route.route_sample", side_effect=sample):
            await verify_clear_and_resume(drone, None, 10.0, blocked)
        self.assertFalse(blocked.is_set())
        start.assert_awaited_once()

    async def test_blocked_segment_rejects_resume_before_any_command(self) -> None:
        blocked = asyncio.Event()
        blocked.set()
        start = AsyncMock()
        drone = SimpleNamespace(mission=SimpleNamespace(start_mission=start))
        with self.assertRaisesRegex(SimulatorError, "segment is blocked"):
            await resume_if_clear(drone, None, blocked)
        start.assert_not_called()

    async def test_clearance_does_not_resume_if_hold_is_lost(self) -> None:
        blocked = asyncio.Event()
        blocked.set()
        start = AsyncMock()
        drone = SimpleNamespace(mission=SimpleNamespace(start_mission=start))
        with patch("scripts.sim1_run_route.route_sample", new=AsyncMock(return_value=(11.0, 0.8, 0.8))):
            with self.assertRaisesRegex(MotionTimeoutError, "without an explicit resume"):
                await verify_clear_and_resume(drone, None, 10.0, blocked)
        self.assertFalse(blocked.is_set())
        start.assert_not_called()


class TestSimulatorCleanup(unittest.TestCase):
    def test_signal_during_first_cleanup_still_removes_both_containers(self) -> None:
        commands = []

        def remove(command, **_kwargs):
            commands.append(command[-1])
            if len(commands) == 1:
                signal.raise_signal(signal.SIGTERM)
            return subprocess.CompletedProcess(command, 0, "", "")

        with patch("scripts.sim1_run_route.subprocess.run", side_effect=remove):
            self.assertFalse(remove_simulator_containers(("px4", "client")))
        self.assertEqual(commands, ["px4", "client"])


if __name__ == "__main__":
    unittest.main()
