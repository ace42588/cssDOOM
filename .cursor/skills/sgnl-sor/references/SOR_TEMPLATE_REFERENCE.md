# SoR template field reference

Distilled from the [SGNL SoR Templates docs](https://help.sgnl.ai/articles/systems-of-record/templates/).
Use this when populating the entity design brief and rendering the YAML.

## Top-level fields

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `displayName` | yes | string | UI label |
| `icon` | no | string | base64 SVG |
| `description` | no | string | |
| `address` | yes (polling/SCIM) | string | API base URL or push endpoint |
| `defaultSyncFrequency` | yes (polling) | enum | `SECONDLY`/`MINUTELY`/`HOURLY`/`DAILY`/`WEEKLY`/`MONTHLY`/`YEARLY` |
| `defaultSyncMinInterval` | yes (polling) | int | Multiplier on the frequency |
| `defaultApiCallFrequency` | yes (polling) | enum | Same enum as above |
| `defaultApiCallMinInterval` | yes (polling) | int | |
| `type` | yes | string | `<Name>-MAJOR.MINOR.PATCH` (e.g. `BambooHR-1.0.0`) |
| `adapterConfig` | yes (polling) | string | base64(JSON) — use `scripts/encode_adapter_config.py` |
| `auth` | yes (polling/SCIM) | list | One or more of `oAuth2ClientCredentials`, `basic`, `bearer` |
| `deliveryMethod` | yes (push) | enum | `eventPush` (Event Push) or `entityPush` (SCIM push) |
| `pushType` | yes (push) | enum | `Custom` (Event Push) or `SCIM2.0` |
| `pushEventsPath` | yes (Event Push) | JSONPath | Selects the events array in inbound payloads |

> **SCIM 2.0 Entity Push limitation.** SGNL's built-in SCIM adapter only
> accepts traffic against `/Users` and `/Groups`. If you need to mirror
> any other resource type, do not invent a custom SCIM path — use Event
> Push instead (see [DECISION_GUIDE.md](DECISION_GUIDE.md)).
| `entities` | yes | mapping | See below |
| `relationships` | no | list/mapping | See below |

## Auth blocks

```yaml
auth:
  - oAuth2ClientCredentials:
      clientId: ...
      clientSecret: ...
      authStyle: InParams | InBody | AutoDetect
      tokenUrl: https://...
      scope: optional
  - basic:
      username: ...
      password: ...
  - bearer:
      authToken: ...
```

## Entities

Each entity sits under `entities:` keyed by its name. `externalId` is the
upstream identifier (REST resource path, SCIM resource type, or — for
Event Push — the literal value `pushExternalId` resolves to).

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `displayName` | yes | string | |
| `externalId` | yes | string | |
| `description` | no | string | |
| `parent` | no | string | externalId of the parent entity |
| `pageSize` | no | int | Default 100 |
| `pagesOrderedById` | yes | bool | True iff the source can sort by the unique id |
| `syncFrequency` / `syncMinInterval` | no | | Override defaults |
| `apiCallFrequency` / `apiCallMinInterval` | no | | Override defaults |
| `attributes` | yes | list | At least one with `uniqueId: true` |
| `pushExternalId` | yes (Event Push) | JSONPath | Where the routing value lives in each event |
| `entityAlias` | no (Event Push child) | string | Local alias for parent/child |

## Attributes

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `name` | yes | string | Logical name |
| `externalId` | yes | string | API field name OR a JSONPath like `$.actor.alternateId` |
| `description` | no | string | |
| `type` | yes | enum | `Bool`, `DateTime`, `Double`, `Duration`, `Int64`, `String` |
| `indexed` | no | bool | True if used in policies or relationships |
| `uniqueId` | no | bool | Exactly one per entity; implies `indexed: true` |
| `list` | no | bool | True if multi-valued |

## Relationships

Three kinds (the validator handles each):

```yaml
relationships:
  GroupMember:                         # entity relationship
    name: Member
    fromAttribute: GroupMember.memberId
    toAttribute: User.id
  UserMemberGroup:                     # path relationship
    name: Group
    path:
      - relationship: GroupMember
        direction: Backward
      - relationship: MemberOf
        direction: Forward
  ParentOfPowerup:                     # parent relationship
    childEntity: Powerup
```

`fromAttribute` / `toAttribute` use the dot syntax
`<entityExternalId>.<attributeExternalId>`. The validator rejects any
reference that does not resolve to an attribute defined under `entities:`.
