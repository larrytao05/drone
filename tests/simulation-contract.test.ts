import { describe, expect, it } from "vitest";
import {
  isAllowedLocalOrigin,
  isLoopbackHost,
  simulationCommandRequestSchema,
  simulationStatusSchema,
  type SimulationStatus,
} from "../src/simulation-contract.js";

describe("simulation-contract", () => {
  describe("isLoopbackHost", () => {
    it("recognizes standard loopback hosts", () => {
      expect(isLoopbackHost("localhost")).toBe(true);
      expect(isLoopbackHost("127.0.0.1")).toBe(true);
      expect(isLoopbackHost("::1")).toBe(true);
      expect(isLoopbackHost("[::1]")).toBe(true);
    });

    it("rejects non-loopback hosts", () => {
      expect(isLoopbackHost("evil.com")).toBe(false);
      expect(isLoopbackHost("192.168.1.1")).toBe(false);
      expect(isLoopbackHost("")).toBe(false);
    });
  });

  describe("isAllowedLocalOrigin", () => {
    it("permits loopback origins by default", () => {
      expect(isAllowedLocalOrigin("http://localhost:3000")).toBe(true);
      expect(isAllowedLocalOrigin("http://127.0.0.1:3000")).toBe(true);
      expect(isAllowedLocalOrigin("http://[::1]:3000")).toBe(true);
      expect(isAllowedLocalOrigin("https://localhost:8443")).toBe(true);
    });

    it("permits null or empty origin for direct/CLI local callers", () => {
      expect(isAllowedLocalOrigin(null)).toBe(true);
      expect(isAllowedLocalOrigin(undefined)).toBe(true);
      expect(isAllowedLocalOrigin("")).toBe(true);
    });

    it("rejects non-local origins", () => {
      expect(isAllowedLocalOrigin("http://evil.com")).toBe(false);
      expect(isAllowedLocalOrigin("https://attacker.org:3000")).toBe(false);
      expect(isAllowedLocalOrigin("http://192.168.1.100:3000")).toBe(false);
      expect(isAllowedLocalOrigin("ftp://localhost:3000")).toBe(false);
      expect(isAllowedLocalOrigin("invalid-url")).toBe(false);
    });

    it("honors SIMULATION_ALLOWED_ORIGIN when specified", () => {
      const customOrigin = "http://my-trusted-host:8080";
      expect(isAllowedLocalOrigin("http://my-trusted-host:8080", customOrigin)).toBe(true);
      expect(isAllowedLocalOrigin("http://localhost:3000", customOrigin)).toBe(false);
      expect(isAllowedLocalOrigin("http://other:8080", customOrigin)).toBe(false);
    });
  });

  describe("simulationCommandRequestSchema", () => {
    it("validates start command", () => {
      const res = simulationCommandRequestSchema.safeParse({ action: "start" });
      expect(res.success).toBe(true);
    });

    it("rejects start command with unrecognized parameters", () => {
      const res = simulationCommandRequestSchema.safeParse({
        action: "start",
        arbitrary: "command",
      });
      expect(res.success).toBe(false);
    });

    it("validates status command", () => {
      expect(simulationCommandRequestSchema.safeParse({ action: "status" }).success).toBe(true);
      expect(
        simulationCommandRequestSchema.safeParse({ action: "status", runId: "sim_123" }).success
      ).toBe(true);
    });

    it("validates resume command requiring runId", () => {
      expect(simulationCommandRequestSchema.safeParse({ action: "resume" }).success).toBe(false);
      expect(
        simulationCommandRequestSchema.safeParse({ action: "resume", runId: "sim_123" }).success
      ).toBe(true);
    });

    it("validates end command requiring runId", () => {
      expect(simulationCommandRequestSchema.safeParse({ action: "end" }).success).toBe(false);
      expect(
        simulationCommandRequestSchema.safeParse({ action: "end", runId: "sim_123" }).success
      ).toBe(true);
    });

    it("rejects browser test-only clear command", () => {
      expect(simulationCommandRequestSchema.safeParse({ action: "clear" }).success).toBe(false);
      expect(
        simulationCommandRequestSchema.safeParse({ action: "clear", runId: "sim_123" }).success
      ).toBe(false);
    });

    it("rejects unknown actions", () => {
      expect(simulationCommandRequestSchema.safeParse({ action: "fly_to_paris" }).success).toBe(
        false
      );
    });
  });

  describe("simulationStatusSchema", () => {
    it("validates a complete simulation status object", () => {
      const status: SimulationStatus = {
        runId: "sim_test_123",
        seq: 5,
        phase: "holding",
        blocked: false,
        holdRequested: true,
        holdConfirmed: true,
        fresh: true,
        telemetry: {
          timestamp: "2026-11-23T00:00:00.000Z",
          sampleAgeMs: 120,
          position: {
            lat: 47.397743,
            lon: 8.545594,
            altM: 10.0,
            northProgressM: 8.5,
          },
          velocity: {
            speedMs: 0.1,
            northSpeedMs: 0.05,
          },
        },
        events: [
          { seq: 1, timestamp: "2026-11-23T00:00:00.000Z", label: "Simulation started" },
          { seq: 2, timestamp: "2026-11-23T00:00:01.000Z", label: "Route motion confirmed" },
          { seq: 3, timestamp: "2026-11-23T00:00:02.000Z", label: "Autopilot commanded hold" },
          { seq: 4, timestamp: "2026-11-23T00:00:03.000Z", label: "Telemetry confirmed hold" },
          { seq: 5, timestamp: "2026-11-23T00:00:05.000Z", label: "Blockage cleared" },
        ],
        error: null,
      };

      const parseResult = simulationStatusSchema.safeParse(status);
      expect(parseResult.success).toBe(true);
    });

    it("validates an in-progress ending simulation status object", () => {
      const status: SimulationStatus = {
        runId: "sim_test_ending",
        seq: 6,
        phase: "ending",
        blocked: false,
        holdRequested: false,
        holdConfirmed: false,
        fresh: true,
        telemetry: null,
        events: [
          { seq: 1, timestamp: "2026-11-23T00:00:00.000Z", label: "Simulation teardown initiated" },
        ],
        error: null,
      };

      const parseResult = simulationStatusSchema.safeParse(status);
      expect(parseResult.success).toBe(true);
    });

    it("validates an error status object", () => {
      const status: SimulationStatus = {
        runId: "sim_test_failed",
        seq: 2,
        phase: "failed",
        blocked: false,
        holdRequested: false,
        holdConfirmed: false,
        fresh: false,
        telemetry: null,
        events: [],
        error: {
          code: "STARTUP_TIMEOUT",
          message: "Preflight readiness timed out after 30s.",
          exitCode: 2,
        },
      };

      const parseResult = simulationStatusSchema.safeParse(status);
      expect(parseResult.success).toBe(true);
    });
  });
});
