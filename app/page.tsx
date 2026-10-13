"use client";

import { useEffect, useState } from "react";
import { planMission } from "@drone/mission-planner";
import type { MissionInput, PlanResult } from "@drone/mission-planner";

const fixedRoute = {
  shot: {
    kind: "route",
    anchors: [
      { latitudeDeg: 0, longitudeDeg: 0 },
      { latitudeDeg: 0, longitudeDeg: 0.001 },
    ],
  },
  heightAboveTakeoffM: 12,
  framing: { kind: "fixed", headingDeg: 90, gimbalPitchDeg: -30 },
} satisfies MissionInput;

const faceTargetRoute = {
  shot: {
    kind: "route",
    anchors: [
      { latitudeDeg: 0, longitudeDeg: 0 },
      { latitudeDeg: 0.003, longitudeDeg: 0 },
    ],
  },
  heightAboveTakeoffM: 5,
  framing: {
    kind: "face-target",
    target: {
      coordinate: { latitudeDeg: 0.002, longitudeDeg: 0 },
      heightAboveTakeoffM: 10,
    },
  },
} satisfies MissionInput;

const invalidRoute = {
  shot: { kind: "route", anchors: [{ latitudeDeg: 0, longitudeDeg: 0 }] },
  heightAboveTakeoffM: 5,
  framing: { kind: "fixed", headingDeg: 90, gimbalPitchDeg: -30 },
} satisfies MissionInput;

export default function HomePage() {
  const [ready, setReady] = useState(false);
  const [result, setResult] = useState<PlanResult | null>(null);

  useEffect(() => setReady(true), []);

  function runMission(input: MissionInput) {
    setResult(planMission(input));
  }

  return (
    <main className="home-page">
      <h1 className="home-page__title">Drone Mission Planner</h1>
      <p className="home-page__intro">Run a mission planning check.</p>
      <div className="home-page__actions">
        <button className="home-page__action" disabled={!ready} onClick={() => runMission(fixedRoute)} type="button">
          Run fixed route
        </button>
        <button className="home-page__action" disabled={!ready} onClick={() => runMission(faceTargetRoute)} type="button">
          Run face-target route
        </button>
        <button className="home-page__action" disabled={!ready} onClick={() => runMission(invalidRoute)} type="button">
          Run invalid route
        </button>
      </div>
      <p className="home-page__status" role="status">
        {result === null
          ? "Choose a route check."
          : result.kind === "calculated"
            ? `Calculated ${result.waypoints.length} waypoints.`
            : "The route has input errors."}
      </p>
      {result?.kind === "calculated" && (
        <div className="home-page__results-scroll" role="region" aria-label="Waypoint results" tabIndex={0}>
          <table aria-label="Calculated waypoints" className="home-page__results">
            <thead>
              <tr>
                <th scope="col">Latitude (°)</th>
                <th scope="col">Longitude (°)</th>
                <th scope="col">Height (m)</th>
                <th scope="col">Heading (°)</th>
                <th scope="col">Pitch (°)</th>
              </tr>
            </thead>
            <tbody>
              {result.waypoints.map((waypoint, index) => (
                <tr key={`${waypoint.coordinate.latitudeDeg},${waypoint.coordinate.longitudeDeg},${index}`}>
                  <td>{waypoint.coordinate.latitudeDeg}</td>
                  <td>{waypoint.coordinate.longitudeDeg}</td>
                  <td>{waypoint.heightAboveTakeoffM}</td>
                  <td>{waypoint.headingDeg}</td>
                  <td>{waypoint.gimbalPitchDeg}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result?.kind === "invalid-input" && (
        <ul aria-label="Planning errors" className="home-page__errors">
          {result.issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`}>
              <span>{issue.code}</span> <span>{issue.path.join(".")}</span> <span>{issue.message}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
