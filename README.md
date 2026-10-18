# DJI mission planner

This project combines a browser-based route editor with a deterministic TypeScript waypoint planner for DJI filming missions. You can plan and review a route, then use DJI Fly separately. The app does not create DJI flight files or control an aircraft.

The editor supports routes with 2 to 100 waypoints. You can set a takeoff point, choose fixed or target-facing camera framing, edit and reorder waypoints, and preview the calculated route. The planner library also calculates orbit geometry, but the browser editor currently supports routes only.

## Run the editor

You need Node.js 22.13 or later in the 22.x line, 24.x, or 26 or later.

```sh
npm ci
npm run dev:web
```

Open `http://localhost:3000`. Map imagery requires a MapTiler API key. Set `MAPTILER_API_KEY` in `.env.local` to enable it. Without a key, you cannot add waypoints on the map. You can still import and edit a route backup, preview the route and save it.

## Plan and save a route

1. Select **New** to start a route and enter a name.
2. Set the takeoff coordinates and flight height above takeoff.
3. Choose fixed heading and gimbal pitch, or face a target and enter its coordinates and height.
4. Add at least 2 waypoints on the map. Select a waypoint to edit its coordinates. Reorder or delete points as needed.
5. Check the route preview, calculated waypoint table and any input errors.
6. Select **Save** to review the route. Mark it as reviewed only after checking the inputs and preview, then confirm to save.

The app stores one route in the current browser profile. It does not autosave or sync routes between browsers or devices. Select **Load** to restore the saved route. Use **Export backup** to download a versioned JSON file, or **Import backup** to load one. A backup contains route inputs, not the review status or calculated results. Imported routes need a new review.

The preview shows planned geometry. It does not check terrain, obstacles, weather, flight permissions, aircraft limits or DJI Fly's interpolated flight path. A reviewed route is not a safety assessment or an executable DJI mission.

## Current scope

The planner validates route and orbit inputs and calculates waypoint coordinates, headings and gimbal pitches. The browser editor currently provides route planning and local saving. Natural-language interpretation, multi-route storage, DJI Fly file export and direct aircraft control are not implemented.
