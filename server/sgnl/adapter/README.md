# SGNL gRPC map adapter

Node service implementing `sgnl.adapter.v1.Adapter` / `GetPage` so SGNL can ingest map data from the same JSON files the game ships under `public/maps/` (override with `MAPS_DIR`).

## Run

The adapter is started automatically by the game server — `npm run server` (or `npm run dev:all`) calls `startSgnlAdapter()` from `server/sgnl/index.js`. No separate process or npm script is required.

When `SGNL_ADAPTER_VALID_TOKENS` is unset the adapter warns and no-ops, so fresh clones stay quiet; set the env var to opt in.

```bash
export SGNL_ADAPTER_VALID_TOKENS='your-shared-secret'
npm run server
```

SGNL must send gRPC metadata `token` with a value in `SGNL_ADAPTER_VALID_TOKENS` (comma-separated list allowed).

## Environment

| Variable | Purpose |
|----------|---------|
| `SGNL_ADAPTER_VALID_TOKENS` | Required to enable the adapter. Shared secret(s) matching SGNL's outbound `token` metadata. If unset the adapter starts disabled. |
| `SGNL_ADAPTER_PORT` | Listen port (default `8081`). |
| `MAPS_DIR` | Directory of `*.json` maps (default: repo `public/maps`). Files are sorted by name; each file is one **Map** parent object. |
| `SGNL_ADAPTER_SOR_TYPE` | Optional. If set, `GetPageRequest.datasource.type` must match or the adapter returns `ERROR_CODE_INVALID_DATASOURCE_CONFIG`. |
| `GRPC_MAX_MESSAGE_LENGTH` | Optional. Max send/receive in bytes (default `268435456` = 256 MiB). Full maps with all nested children can be very large; raise this and matching limits on SGNL / proxies if ingestion fails. |

## Semantics

- **Only** the root entity `external_id` **`map`** is supported. `GetPage` for any other `entity.external_id` returns `ERROR_CODE_INVALID_ENTITY_CONFIG` (4).
- **Map list pagination**: `cursor` is a start offset into the sorted `*.json` basenames; `page_size` caps how many map files are returned (default 10 if unset or invalid). `next_cursor` is the next offset string, or empty when done.
- **No map name in `adapterConfig`**: map selection is purely from the filesystem; `datasource.config` is not used to pick a map.
- **Curated interactables only** — the adapter deliberately does not expose raw geometry (vertices, linedefs, sidedefs, sectors, walls, sectorPolygons, sightLines, raw things). Requested child entities are limited to the curated set in [`interactables.js`](./interactables.js): `doors`, `switches`, `keys`, `pickups`, `exits`, `lifts`, `teleporters`, `crushers`. Any other `child_entities.external_id` returns `ERROR_CODE_INVALID_ENTITY_CONFIG` (4).
- **Stable `id` per row** — every row carries an `id` of the form `<kind>:<MAP>:<key>` (for example `door:E1M1:42`, `switch:E1M1:ld330`, `key:E1M1:17`). This string is the `assetId` the engine sends to SGNL Access Evaluations, and the `userName` the matching SCIM resource uses, so static + dynamic payloads correlate without a join.
- **SoR template**: keep `type` and entity `external_id` values in sync with this service — see [`public/sgnl/map-sor.yaml`](../../../public/sgnl/map-sor.yaml).

## Proto

[`adapter.proto`](./adapter.proto) is the SGNL adapter API; `index.js` loads it with `keepCase: true`, so outbound payloads use **snake_case** field names (`entity_id`, `child_objects`, `next_cursor`, …).
