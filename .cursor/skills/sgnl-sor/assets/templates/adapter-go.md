# Go adapter — clone SGNL's official template

When the project's dominant language is Go (or no Node/Python is detected),
follow SGNL's documented Go adapter workflow rather than re-rendering from
scratch. The official template is the source of truth and ships with the
`SCAFFOLDING #1`–`#25` pointers the rest of the SGNL docs reference.

## Steps

1. Clone the template into the working directory:

   ```bash
   git clone https://github.com/SGNL-ai/adapter-template.git \
     sgnl-work/{{SOR_NAME}}/draft/adapter
   ```

2. Replace import path references — anywhere `sgnl-ai/adapter-template`
   appears, swap in your destination repo path.

3. Walk the `SCAFFOLDING #N` sites in order. The minimum set to update is:

   | # | File | Change |
   |---|------|--------|
   | 2 | `cmd/adapter/main.go` | `RegisterAdapter(server, "{{SOR_TYPE}}", ...)` |
   | 3-4 | `pkg/adapter/config.go` | Adapter config struct + Validate fields |
   | 11, 15 | `pkg/adapter/datasource.go` | Add each entity `external_id` to `ValidEntityExternalIDs` (matches `entities:` keys in the SoR YAML) |
   | 16 | `pkg/adapter/datasource.go` | Construct upstream URL per entity |
   | 17 | `pkg/adapter/datasource.go` | Set `Accept` / auth headers |
   | 17-1, 18, 19 | `pkg/adapter/datasource.go` | Per-entity `ParseResponse` + `next_cursor` |
   | 22 | `pkg/adapter/adapter.go` | Map gRPC `Auth` → upstream credentials |

4. Build and test against the same `adapter.proto` as the Node/Python
   templates (it lives next to this file as `adapter.proto`).

5. Authentication token file: `openssl rand 64 | openssl enc -base64 -A`
   then write `["<token>"]` into `authtokens.json` and export
   `AUTH_TOKENS_PATH=$(pwd)/authtokens.json`.

## Reference

- [Creating and Configuring a Custom Adapter](https://help.sgnl.ai/articles/systems-of-record/creating-and-configuring-custom-adapter/)
- [SGNL-ai/adapter-template](https://github.com/SGNL-ai/adapter-template)
