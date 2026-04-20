# {{SOR_NAME}} — Entity Design Brief

This brief is the single source of truth for the SoR YAML the skill will
render. Fill every section completely; the renderer treats it as the
contract.

## SoR metadata

| Field | Value |
|-------|-------|
| `displayName` | <human-readable name> |
| `description` | <one paragraph: what entities, why> |
| `address` | <upstream API base URL or SGNL push endpoint base> |
| `type` | `<Name>-1.0.0` (must match the adapter registration) |
| Flow | one of: `polling` / `eventpush` / `scim` |
| Auth | one of: `oAuth2ClientCredentials` / `basic` / `bearer` |
| Default sync | e.g. `HOURLY` × 1 |
| Default API call | e.g. `SECONDLY` × 1 |
| `adapterConfig` (raw JSON before base64) | `{}` |

## Entities

For each entity, fill one block. The `externalId` of an entity is what the
upstream API (polling), event payload (Event Push), or SCIM resource type
identifies it as. The first attribute MUST be the unique id.

### `<entityExternalId>`

- **displayName**: <human label>
- **description**: <what it represents>
- **route / endpoint** (polling only): `/path/under/address`
- **pushExternalId** (Event Push only): JSONPath to the event-type field
  (e.g. `$.eventType`)
- **parent** (optional): externalId of parent entity
- **pageSize**: integer (default 100)
- **pagesOrderedById**: true/false

| Attribute (`name`) | `externalId` | `type` | `uniqueId` | `indexed` | `list` | Notes |
|--------------------|--------------|--------|------------|-----------|--------|-------|
| id | id | String | true | true | false | Required: exactly one per entity |
| ... | ... | ... | false | false | false | |

Repeat one block per entity.

## Relationships

### Entity relationships (cross-entity joins)

| Key | `name` | `fromAttribute` | `toAttribute` |
|-----|--------|-----------------|---------------|
| <RelKey> | <Display> | `<entity>.<attr>` | `<entity>.<attr>` |

### Path relationships (chained)

| Key | `name` | Path (relationship key + direction) |
|-----|--------|--------------------------------------|
| <PathKey> | <Display> | `RelA` FORWARD → `RelB` FORWARD |

### Parent relationships

Auto-derived from any entity that sets `parent:`. List the child entities
explicitly here:

- `<childExternalId>` (parent = `<parentExternalId>`)

## Validation reminders

- Exactly one `uniqueId: true` per entity.
- Every `uniqueId: true` attribute must also be `indexed: true`.
- Any attribute used in `relationships` or in policies must be `indexed: true`.
- `externalId` may be a JSONPath when the upstream payload is nested
  (e.g. `$.actor.alternateId`); document each such use here so the
  generated YAML matches the upstream schema.
