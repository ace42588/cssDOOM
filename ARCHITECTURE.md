# Architecture Boundaries

The source tree is organized by runtime ownership:

- `src/engine/` contains environment-neutral simulation: world state, actors,
  physics, combat, AI, line specials, map loading, and host-facing ports.
- `src/client/` contains browser-only code: DOM rendering, Web Audio, input
  devices, WebSocket client synchronization, UI, and browser WebMCP.
- `src/shared/` contains contracts used by both browser and server. Shared
  modules must not depend on `engine`, `client`, or `server`.
- `server/` contains the authoritative Node host, realtime transports, admin
  API, server MCP, and SGNL integration.

Allowed dependency direction:

```text
server  -> src/engine, src/shared
client  -> src/engine, src/shared
engine  -> src/shared
shared  -> package dependencies only
```

Important details:

- Engine side effects go through ports in `src/engine/ports/`. Browser DOM,
  Web Audio, and server recording hosts install implementations there.
- `src/client/renderer/scene/sector-mechanics/` is visual state only. The
  matching simulation lives in `src/engine/mechanics/`.
- Browser WebMCP lives in `src/client/webmcp/`. Authoritative MCP lives in
  `server/mcp/`.
- Actor capabilities, runtime ids, and possession helpers live under
  `src/engine/actors/`; map-spawned DOOM things live under
  `src/engine/things/`.

Run `npm run lint:architecture` after moving files. The checker blocks import
cycles across these ownership boundaries and catches old path drift such as
`src/game`, `src/mcp`, `src/renderer/scene/mechanics`, or `src/engine/entity`.
