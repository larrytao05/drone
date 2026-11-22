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

## Use the mission assistant

Complete the route's waypoint coordinates, height and framing settings, then sign in under **Mission assistant** with the configured assistant password. Takeoff is optional for chat and remains required before you mark a route as reviewed. If assistant access is unavailable, manual editing remains usable.

Send a message to request a height change. The editor calculates the comparison locally. Select **Apply proposed change** to update the height, or **Dismiss** to keep the source. Editing the source makes an existing proposal stale. Applying a change does not save the route.

**Cancel request** retires a pending result. **Retry same request** explicitly checks the original request after a connection or service failure. It reuses the original request ID and body within the server's retry window. A terminal assistant failure requires a new message. **Clear conversation**, **New**, successful import or load, and authentication changes discard pending results and proposals. Conversation text stays in memory and is lost on reload.

The managed local browser suites include fake-endpoint assistant journeys and make no paid model calls.

## Private chat endpoint

`POST /api/agent/session` accepts JSON actions `status`, `login` with a `password`, and `logout`. `status` is the browser bootstrap request. After login, it returns `{ authenticated: true, epoch, serverNow, retryWindowMs }`; without a valid session, it returns `{ authenticated: false }`. Import `agentSessionRequestSchema`, `agentSessionResponseSchema` and `formatAgentRequestId` from `@drone/mission-planner/agent-contract` for browser integration. Every session request uses `POST` with JSON and an exact `Origin` header. The browser chat route is `POST /api/agent`. Both routes require the configured origin; chat also requires a valid session cookie.

For local development, set `AGENT_LOGIN_PASSWORD` (12–256 characters), `AGENT_SESSION_SECRET` (at least 32 characters), and `AGENT_ALLOWED_ORIGIN` (for example, `http://localhost:3000`) in `.env.local`. The default model provider is OpenAI. Set `OPENAI_API_KEY` and an explicit `OPENAI_MODEL`, or select OpenRouter with `AGENT_MODEL_PROVIDER=openrouter`, `OPENROUTER_API_KEY`, and optionally `OPENROUTER_MODEL=openrouter/free`. OpenRouter accepts `openrouter/free` or a model ID ending in `:free`; it does not fall back to paid models. The free router chooses an available model and may have lower rate limits, changing availability, or limited tool support. See [OpenRouter's free models router](https://openrouter.ai/docs/guides/routing/routers/free-router) and [OpenAI SDK integration](https://openrouter.ai/docs/guides/community/openai-sdk). The allowed origin must be an exact HTTPS origin in deployment. Plain HTTP is accepted only for a configured loopback origin. Missing or invalid configuration returns 503. The session cookie is signed, expires after 8 hours, uses `HttpOnly` and `SameSite=Strict`, and uses `Secure` for HTTPS. Logout invalidates existing sessions and request IDs. No password, API token or provider key belongs in browser code or a `NEXT_PUBLIC_` variable.

Browser request IDs have the form `epoch.createdAt.uuid`. Use the authenticated bootstrap's epoch and a millisecond creation time with `formatAgentRequestId`; generate a fresh UUID for each new attempt. The server accepts an ID for 2 minutes, with up to 5 seconds of future clock skew. An exact retry within that window joins or replays its first admitted result. Changing the request under the same ID returns 409. Expired IDs, IDs from a previous server epoch and IDs from before logout are rejected without inference. Browser clients should refresh session status after reauthentication and discard old retry state. The session and admission cache are held in 1 Node process; deploy this route with 1 process and no distributed replicas. A restart requires a new login and makes previous IDs unavailable for retry. The endpoint holds up to 16 admitted requests, admits up to 12 new requests per minute and runs at most 2 turns at once. Login allows 5 attempts per minute. A full cache rejects new work rather than evicting an unexpired result.

`POST /api/chat` remains a separate bearer-token route for private CLI and integration clients. Set `AGENT_API_TOKEN` to use it. Its request IDs do not have the browser route's retry and admission guarantees. Neither route exposes the private token or provider key to browser code.

`POST /api/chat` accepts complete planner inputs from a private client. Copy `.env.example` to `.env.local` and set `AGENT_API_TOKEN` and the selected provider's configuration. Run `npm run dev:web` for local API development. The token and provider key stay on the server. Do not place them in browser code or `NEXT_PUBLIC_` variables. The route returns 503 until the required configuration is present and checks `Authorization: Bearer <AGENT_API_TOKEN>` before reading a request or constructing a model.

The request contains a request ID, user message, optional chat history, a complete mission snapshot and a caller-supplied binding. The binding carries the mission branch ID, revision, canonical input digest, schema version and planner version. The response echoes the request ID and binding for every parsed request outcome. A proposal contains a validated change and tool activity; the client calculates candidate waypoints locally from its snapshot. The route accepts height and orbit-radius changes. It never applies a proposal or controls a drone. The endpoint cannot verify the current editor revision. A client must compare the full binding against its pending snapshot and current revision before it displays or applies a result.

Requests must use JSON and fit within 64 KiB. Request ID, message, history and binding data must fit within 24,000 bytes. The browser route checks server-owned schema and planner versions and recomputes the snapshot digest before admitting work. Each turn allows at most 4 model calls, 6 tool calls and 30 seconds. The provider makes no automatic SDK retries. OpenAI uses the Responses API with `store: false`; OpenRouter uses Chat Completions, and OpenAI's setting does not control OpenRouter data handling. Review [OpenRouter's data policies](https://openrouter.ai/docs/guides/privacy/data-collection) for its logging and provider privacy controls. The model receives no snapshot coordinates in the generated context or tool results, but user-written text can contain location data. The server does not know the current editor revision or accept a proposal on the editor's behalf. The editor uses the browser client for session access and text-only conversation. Streaming and chat persistence are not implemented.

## Agent runtime contract

Import `runAgentTurn` from `@drone/mission-planner/agent`. The caller supplies an AI SDK `LanguageModel`, an immutable snapshot and binding, a change schema, a redacted context description function and a preview function. The runtime does not configure a provider or read or mutate a live mission. Keep coordinates and other private data out of context descriptions, preview summaries and diagnostics. The runtime does not send the raw snapshot or candidate to the model.

Import the browser-safe schemas, `canonicalMissionInput`, `digestMissionInput` and `previewMissionChange` from `@drone/mission-planner/agent-contract`. `editorHeightChangeSchema` limits the current route editor to `set-height`; `missionChangeSchema` also supports `set-orbit-radius` for the private server's orbit flow. The canonical string encodes validated mission input with sorted object keys and original array order. The digest is SHA-256 of that string with the planner version as a domain prefix. The browser must recalculate a proposal with its current input before accepting it. The authenticated browser endpoint enforces digest and version compatibility; the private bearer route retains its original contract.

The runtime exposes four fixed tools: `get_mission_context`, `preview_change`, `propose_change` and `ask_clarification`. It allows at most 4 model calls, 6 tool calls and 30 seconds per turn by default. It disables SDK retries and limits history to 12 user or assistant messages, with 4,000 characters per message and 24 KB for combined turn metadata and text. Model output is limited to 1,000 tokens. Answer text is limited to 4,000 characters, and each structured model-facing result is limited to 8 KB.

A turn returns `answered` with text, `needs-input` with a question, `proposed` with the unchanged binding, exact validated change and opaque candidate, or a `failed`, `cancelled`, `deadline` or `budget-exceeded` outcome. Every outcome includes tool activity. The private HTTP response removes the internal candidate and puts the outcome inside a response envelope with the request ID and binding. Cancellation and deadlines suppress late results, even when an operation ignores its abort signal. Such an operation may remain pending after the turn returns. A proposal is staged for caller review. The runtime does not accept it or update mission state.

## Current scope

The planner validates route and orbit inputs and calculates waypoint coordinates, headings and gimbal pitches. The browser editor currently provides route planning and local saving. The mission assistant supports reviewed height-change proposals. Multi-route storage, DJI Fly file export and direct aircraft control are not implemented.
