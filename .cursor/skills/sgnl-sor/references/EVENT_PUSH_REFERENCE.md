# Event Push reference

Specifics for the Event Push flow ([source](https://help.sgnl.ai/articles/systems-of-record/creating-and-configuring-event-push/)).

## Wire mechanics

- Upstream POSTs JSON to
  `https://{client}.sgnlapis.cloud/events/custom/v1/{datasourceId}`.
- `Authorization: Bearer <token>` (token issued by SGNL at SoR creation).
- `Content-Type: application/json`.
- Successful ingest returns HTTP `202 Accepted`.
- Retention: events are kept ≤ 30 days; ≤ 50 event types per subject.

## Template required fields

```yaml
deliveryMethod: eventPush
pushType: Custom
pushEventsPath: <JSONPath>     # selects the events array in the payload
```

For the Okta example, `pushEventsPath: $.data.events[*]`.

## Per-entity routing

Each entity binds to events whose `pushExternalId`-resolved value equals
its declared `externalId`:

```yaml
entities:
  UserLifecycleDeactivate:
    externalId: user.lifecycle.deactivate   # literal expected value
    pushExternalId: $.eventType             # where to find it in the event
    attributes:
      - name: id
        externalId: $.uuid                  # JSONPath under the event root
        type: String
        uniqueId: true
        indexed: true
      - name: subject
        externalId: $.actor.alternateId
        type: String
        indexed: true
```

The skill keeps these conventions:

- Always set `uniqueId: true` AND `indexed: true` on the event id (e.g.
  `$.uuid`, `$.eventId`).
- Always set `indexed: true` on the subject identifier the policy keys
  off (commonly `$.actor.alternateId` or an email).
- Do not set `auth:` — Event Push uses the SGNL-issued bearer token only.
- Do not set `address:` — the endpoint is issued by SGNL on save.

## Parent / child events

Targets nested inside an event become a child entity with `parent:`
pointing at the parent's `externalId`, and a JSONPath `externalId` on
the child:

```yaml
TargetUserLifecycleDeactivate:
  parent: user.lifecycle.deactivate
  externalId: $.target               # JSONPath into the parent event
  pushExternalId: $.target
  entityAlias: targetUserLifecycleDeactivate
  attributes:
    - name: id
      externalId: $.id               # under each target object
      type: String
      uniqueId: true
      indexed: true
```

## JSONPath cheatsheet

| Need | JSONPath |
|------|----------|
| Top-level field | `$.field` |
| Nested object | `$.outcome.result` |
| Array element | `$.target[0].id` |
| Iterate array | `$.target[*]` (use as `pushEventsPath` or `externalId`) |
| Filter | `$.events[?(@.severity=="INFO")]` |

See the [JSONPath docs](https://help.sgnl.ai/articles/administration/using-json-path/)
for the full grammar SGNL supports.
