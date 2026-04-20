# Adapter protocol — `sgnl.adapter.v1.Adapter`

The adapter speaks gRPC. The full proto is shipped at
`assets/templates/adapter.proto` (a copy of cssDOOM's
[server/sgnl/adapter/adapter.proto](../../../../server/sgnl/adapter/adapter.proto));
this page summarizes the parts the templates implement.

## RPC

```proto
service Adapter {
    rpc GetPage(GetPageRequest) returns (GetPageResponse) {}
}
```

There is exactly one RPC. SGNL invokes it once per entity per sync tick,
passing a `cursor` for pagination.

## Request shape

```proto
message GetPageRequest {
    DatasourceConfig datasource = 1;   // id, type, address, auth, config (bytes)
    EntityConfig     entity     = 2;   // external_id, attributes[], child_entities[]
    int64            page_size  = 3;
    string           cursor     = 4;
}
```

- `datasource.type` MUST equal the `type` registered by your adapter
  (e.g. `BambooHR-1.0.0`). Reject mismatches with
  `ERROR_CODE_INVALID_DATASOURCE_CONFIG` (2).
- `datasource.config` is the base64-decoded value of the SoR YAML's
  `adapterConfig` (raw bytes). Cast to JSON if you encoded JSON.
- `entity.external_id` MUST match one of the entity keys in the SoR YAML.
  Reject unknown values with `ERROR_CODE_INVALID_ENTITY_CONFIG` (4).
- `entity.attributes[*].external_id` is the field SGNL wants returned.
  When the SoR YAML uses a JSONPath externalId, the same JSONPath comes
  through here.

## Response shape

```proto
message GetPageResponse {
    oneof response {
        Page  success = 1;   // objects[] + next_cursor
        Error error   = 2;   // message, code, retry_after
    }
}
```

Return `next_cursor: ""` to signal the last page. Return `Error` with one
of the `ERROR_CODE_*` enum values (see proto) for any failure.

## Authentication (SGNL → adapter)

A shared secret in gRPC metadata key `token`. The adapter rejects
requests whose `token` is not in `SGNL_ADAPTER_VALID_TOKENS` (or the
`authtokens.json` file in the Go template).

Generate a token with:

```bash
openssl rand 64 | openssl enc -base64 -A
```

## Authentication (adapter → upstream)

Pulled from `datasource.auth`:

```proto
oneof auth_mechanism {
    Basic  basic              = 1;   // username + password
    string http_authorization = 2;   // includes "Bearer "/"Basic " prefix
}
```

OAuth2 client credentials are exchanged outside the adapter; SGNL
forwards the resulting bearer in `http_authorization`.

## Implementation checklist

Whatever language template the skill picks, verify the adapter:

1. Validates the `token` metadata.
2. Validates `datasource.type` (when configured).
3. Validates `entity.external_id` against the YAML's entity keys.
4. Resolves the upstream URL: `address + per-entity route`.
5. Resolves auth from `datasource.auth`.
6. Maps each upstream record into `Object.attributes` keyed by
   `attribute.id` (NOT `external_id`) with the right `AttributeValue`
   oneof field for the declared type.
7. Returns `next_cursor` (empty string when done).
8. Maps upstream errors to a sensible `ErrorCode`.

The Go template (cloned from [SGNL-ai/adapter-template](https://github.com/SGNL-ai/adapter-template))
flags each of these via `SCAFFOLDING #N` comments — see
[adapter-go.md](../assets/templates/adapter-go.md) for the mapping.
