---
name: sgnl-sor
description: Generate or update a SGNL System of Record YAML template (and a minimal custom gRPC adapter when a polling SoR is in scope). Auto-detects the project's dominant language and likely entities. Use when the user asks to add, scaffold, or update a SGNL SoR, adapter, Event Push template, or SCIM template.
---

# /sgnl-sor

End-to-end workflow for adding or updating a SGNL System of Record. The
agent runs every script directly; the user is never asked to run a
command. Use the **repository workspace root** as the working directory
for paths like `sgnl-work/{{SOR_NAME}}/...` and when invoking the scripts
below.

## Setup

Read these files once before starting:

- `references/DECISION_GUIDE.md` — pick polling / eventpush / scim
- `references/SOR_TEMPLATE_REFERENCE.md` — every YAML field
- `references/ADAPTER_PROTOCOL.md` — gRPC contract (polling only)
- `references/EVENT_PUSH_REFERENCE.md` — JSONPath conventions (Event Push only)
- `assets/ENTITY_DESIGN_BRIEF.md` — brief format
- `assets/templates/*.tmpl` — the YAML and adapter source templates
- `assets/README_TEMPLATE.md` — per-SoR README skeleton

## Input

The user may provide a `{{SOR_NAME}}` (short, hyphen/underscore-safe;
e.g. `bamboohr`, `okta-events`, `cssdoom-map`). If absent, derive one
from the upstream system name and confirm via `AskQuestion`.

Optional inputs:

- A pointer to upstream API docs / OpenAPI / SCIM schema / event payload.
- Whether this is a **create** or **update** (auto-detected in Phase A).

---

## Phase A — Discovery

### Step 1 — Scaffold the working directory

Run `bash .cursor/skills/sgnl-sor/scripts/scaffold.sh {{SOR_NAME}}`. This
creates `sgnl-work/{{SOR_NAME}}/{brief,draft,out}/` plus an empty
`validate.log`, and adds `sgnl-work/` to `.gitignore` if needed. All
intermediate artifacts go under `sgnl-work/{{SOR_NAME}}/`.

### Step 2 — Detect the project shape

Run `python3 .cursor/skills/sgnl-sor/scripts/detect_project.py` and parse
the JSON it prints. The report contains:

- `dominantLanguage` — `node`, `python`, `go`, `java`, `rust`, `ruby`,
  `csharp`, or `unknown`.
- `existingSorYamls` — files that already look like SoR templates.
- `candidateEntities` — likely entity names from JSON Schemas, OpenAPI,
  and `**/schemas|models|entities/**` source files.

Save the report to `sgnl-work/{{SOR_NAME}}/brief/detect.json` for reuse.

### Step 3 — Create vs update

If `existingSorYamls` includes anything matching `{{SOR_NAME}}` or the
upstream system, ask via `AskQuestion`:

- "Update an existing SoR or create a new one?" with options listing the
  candidate paths plus a "Create new" option.

In **update** mode, copy the chosen YAML into
`sgnl-work/{{SOR_NAME}}/draft/sor.yaml` as the starting point and ask the
user what changed (added/removed entities, attributes, relationships).

---

## Phase B — Pick the SoR flow

Use `references/DECISION_GUIDE.md` to choose `polling` / `eventpush` /
`scim`. If the upstream system is obvious (e.g. "BambooHR" → polling,
"Okta Event Hooks" → eventpush, "Workday SCIM" → scim) state the choice
and proceed. Otherwise ask the user via `AskQuestion`.

**Hard constraint**: SGNL's SCIM 2.0 Entity Push only accepts `/Users`
and `/Groups`. If the upstream domain is anything other than users or
groups (doors, devices, tickets, sessions, game entities, …), `scim` is
not an option — pick `eventpush` (discrete state-change events) or
`polling` (full-collection enumeration).

Record the chosen flow in `sgnl-work/{{SOR_NAME}}/brief/flow.txt`.

---

## Phase C — Entity & relationship brief

Produce a completed copy of `assets/ENTITY_DESIGN_BRIEF.md` at
`sgnl-work/{{SOR_NAME}}/brief/BRIEF.md`. The brief is the single source
of truth for the YAML render in Phase D — every entity, attribute,
relationship, and metadata field must be filled.

Pre-populate from:

1. **Update mode**: parse the existing YAML in
   `sgnl-work/{{SOR_NAME}}/draft/sor.yaml` and fold its current entities
   into the brief, marking each as KEEP / MODIFY / REMOVE.
2. **Create mode**: seed entities from `candidateEntities` (Step 2). Read
   any OpenAPI specs or JSON Schemas they reference to draft attributes.
3. **Always**: align `externalId` of entities and attributes with the
   upstream API names. For Event Push, attribute `externalId`s are
   JSONPath expressions; consult `references/EVENT_PUSH_REFERENCE.md`.

After drafting, present the brief inline and ask the user to confirm via
`AskQuestion` (`Looks good — generate YAML` / `Edit brief first`). Loop
until approved. Do not advance until confirmed.

---

## Phase D — Render the SoR YAML

### Step 1 — Build the variables file

Create `sgnl-work/{{SOR_NAME}}/draft/vars.json`. The keys depend on the
flow; consult `assets/templates/sor-<flow>.yaml.tmpl` for the exact
`{{KEY}}` placeholders. Common keys:

- Scalars: `DISPLAY_NAME`, `DESCRIPTION`, `ADDRESS`, `SOR_TYPE`,
  `ICON_BASE64`, frequency / interval ints.
- Pre-rendered blocks (the agent assembles these as YAML strings in the
  variables JSON):
  - `AUTH_BLOCK` — indented 2 spaces, one auth scheme entry.
  - `ENTITIES_BLOCK` — full `entities:` body (each entity already
    indented two spaces).
  - `RELATIONSHIPS_BLOCK` — full `relationships:` body, or a single
    `# none` comment.
  - `ADAPTER_CONFIG_B64` — see Step 2.
  - For Event Push: `PUSH_EVENTS_PATH`.
  - For SCIM push: `DELIVERY_BLOCK` containing `deliveryMethod:` and
    `pushType:` lines.

Reproduce the indentation conventions used in
[public/sgnl/map-sor.yaml](../../../public/sgnl/map-sor.yaml) (two
spaces per level, attributes lists with `- name:` markers).

### Step 2 — Encode adapterConfig

Polling and SCIM only. Write the raw JSON config (often `{}`) to
`sgnl-work/{{SOR_NAME}}/draft/adapter-config.json`, then run:

```bash
python3 .cursor/skills/sgnl-sor/scripts/encode_adapter_config.py \
  sgnl-work/{{SOR_NAME}}/draft/adapter-config.json
```

Put the printed base64 string into `vars.json` as `ADAPTER_CONFIG_B64`.

### Step 3 — Render

```bash
python3 .cursor/skills/sgnl-sor/scripts/render_template.py \
  .cursor/skills/sgnl-sor/assets/templates/sor-<flow>.yaml.tmpl \
  sgnl-work/{{SOR_NAME}}/draft/vars.json \
  --out sgnl-work/{{SOR_NAME}}/draft/sor.yaml
```

The renderer fails loudly if any `{{KEY}}` is missing — fix `vars.json`
and rerun, do not edit the template.

---

## Phase E — Render the adapter (polling flow only)

Skip this phase entirely for Event Push and SCIM.

### Step 1 — Pick the language template

Map `dominantLanguage` → template file:

| dominantLanguage | template |
|------------------|----------|
| `node`           | `assets/templates/adapter-node.js.tmpl` |
| `python`         | `assets/templates/adapter-python.py.tmpl` |
| `go`             | follow `assets/templates/adapter-go.md` (clone SGNL's official Go template) |
| anything else    | follow `assets/templates/adapter-go.md` as the documented fallback |

For `go`, do not render — instead walk the user through the cloning
checklist in `adapter-go.md` and stop after Phase F validation.

### Step 2 — Build the adapter variables

Create `sgnl-work/{{SOR_NAME}}/draft/adapter-vars.json` with:

- `SOR_TYPE` — same value as the YAML `type:`.
- `SOR_DISPLAY_NAME` — for header comments.
- `ENTITY_ROUTES_JSON` — a JSON object literal mapping each entity's
  `externalId` to the upstream relative path (e.g.
  `{"directory":"v1/employees/directory","applications":"v1/applicant_tracking/applications"}`).
- `ENTITY_ROUTE_COMMENT` — a multi-line comment listing those routes for
  humans (lines start with ` *  ` for Node, `    ` for Python).

### Step 3 — Render

```bash
python3 .cursor/skills/sgnl-sor/scripts/render_template.py \
  .cursor/skills/sgnl-sor/assets/templates/adapter-<lang>.<ext>.tmpl \
  sgnl-work/{{SOR_NAME}}/draft/adapter-vars.json \
  --out sgnl-work/{{SOR_NAME}}/draft/adapter.<ext>
```

Then copy the proto next to it:

```bash
cp .cursor/skills/sgnl-sor/assets/templates/adapter.proto \
   sgnl-work/{{SOR_NAME}}/draft/adapter.proto
```

---

## Phase F — Validate, diff, place outputs

### Step 1 — Validate the YAML

```bash
python3 .cursor/skills/sgnl-sor/scripts/validate_sor_yaml.py \
  sgnl-work/{{SOR_NAME}}/draft/sor.yaml \
  | tee sgnl-work/{{SOR_NAME}}/validate.log
```

The validator exits non-zero on any structural error (missing required
field, unique-id violation, dangling relationship reference, bad base64,
…). On failure, fix the brief or `vars.json` and rerun Phase D — do not
hand-edit the rendered YAML.

### Step 2 — Decide final paths

Inspect the repo layout:

- If `public/sgnl/` exists (cssDOOM convention): final YAML →
  `public/sgnl/{{SOR_NAME}}-sor.yaml`; final adapter (polling) →
  `server/sgnl/adapter-{{SOR_NAME}}/`.
- Else if a top-level `sgnl/` directory exists, mirror that layout.
- Else write everything to `sgnl-work/{{SOR_NAME}}/out/` and tell the
  user where to move them.

### Step 3 — Diff against any existing files

For update mode, run `git diff --no-index` (or `diff -u`) between the
existing destination file and the draft. Present the diff to the user
and ask via `AskQuestion` whether to overwrite.

### Step 4 — Render the README

Render `assets/README_TEMPLATE.md` with `render_template.py` to
`<destination>/README.md`. Include `RUN_COMMAND` matching the language:
`npm run server`, `python adapter.py`, etc.

### Step 5 — Final summary

Reply to the user with:

1. The destination paths that were written.
2. The validator's warning count and any remaining warnings.
3. Next manual steps: register the adapter type in the SGNL Console,
   upload the YAML, set `SGNL_ADAPTER_VALID_TOKENS`, and (if applicable)
   point the upstream system at the Event Push endpoint SGNL will issue.

---

## Determinism rules

- Never invent fields that do not exist in `references/SOR_TEMPLATE_REFERENCE.md`.
- Always render via `render_template.py` — never hand-write a YAML or
  adapter file from scratch.
- Always validate with `validate_sor_yaml.py` before placing outputs.
- Always derive `dominantLanguage` from `detect_project.py`; do not
  guess the project's language from filenames or memory.
- Keep all intermediates under `sgnl-work/{{SOR_NAME}}/`. Final outputs
  only land in repo-tracked locations after Phase F Step 3 confirmation.
