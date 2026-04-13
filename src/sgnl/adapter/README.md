# SGNL gRPC map adapter

Node service implementing `sgnl.adapter.v1.Adapter` / `GetPage` so SGNL can ingest map data from the same JSON files the game ships under `public/maps/` (override with `MAPS_DIR`).

## Run

```bash
export VALID_TOKENS='your-shared-secret'
npm run sgnl:adapter
```

Listens on `PORT` (default `8080`). SGNL must send gRPC metadata `token` with a value in `VALID_TOKENS` (comma-separated list allowed).

## Environment

| Variable | Purpose |
|----------|---------|
| `VALID_TOKENS` | Required. Shared secret(s) matching SGNL’s outbound `token` metadata. |
| `PORT` | Listen port (default `8080`). |
| `MAPS_DIR` | Directory of `*.json` maps (default: repo `public/maps`). Files are sorted by name; each file is one **Map** parent object. |
| `SOR_TYPE` | Optional. If set, `GetPageRequest.datasource.type` must match or the adapter returns `ERROR_CODE_INVALID_DATASOURCE_CONFIG`. |
| `GRPC_MAX_MESSAGE_LENGTH` | Optional. Max send/receive in bytes (default `268435456` = 256 MiB). Full maps with all nested children can be very large; raise this and matching limits on SGNL / proxies if ingestion fails. |

## Semantics

- **Only** the root entity `external_id` **`map`** is supported. `GetPage` for any other `entity.external_id` returns `ERROR_CODE_INVALID_ENTITY_CONFIG` (4).
- **Map list pagination**: `cursor` is a start offset into the sorted `*.json` basenames; `page_size` caps how many map files are returned (default 10 if unset or invalid). `next_cursor` is the next offset string, or empty when done.
- **No map name in `adapterConfig`**: map selection is purely from the filesystem; `datasource.config` is not used to pick a map.
- For each returned map, **every** requested `child_entities` entry is expanded to **all** elements of the matching top-level JSON array (`vertices`, `linedefs`, …). Each row is the native JSON object plus an `index` field (array position) for stable ids. Nested arrays (e.g. `lifts.shaftWalls`) are exposed via JSON **String** attributes in [`public/sgnl/sor.yaml`](../../../public/sgnl/sor.yaml) using `ATTRIBUTE_TYPE_STRING` serialization.
- **SoR template**: keep `type` and entity `external_id` values in sync with this service — see [`public/sgnl/sor.yaml`](../../../public/sgnl/sor.yaml).

## Proto

[`adapter.proto`](./adapter.proto) is the SGNL adapter API; `index.js` loads it with `keepCase: true`, so outbound payloads use **snake_case** field names (`entity_id`, `child_objects`, `next_cursor`, …).
