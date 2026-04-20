# Decision guide: which SGNL SoR flow?

SGNL supports three integration patterns. The skill picks one per SoR.
Pick by **direction of traffic** first, then by **payload shape**.

## Quick matrix

| Situation | Direction | Flow |
|-----------|-----------|------|
| SGNL pulls from your API on a schedule | SGNL → upstream | **polling** (custom gRPC adapter) |
| Upstream pushes discrete JSON events (webhooks, event hooks, SIEM) | Upstream → SGNL | **eventpush** |
| Upstream is users or groups only, and you want SGNL to maintain a mirrored copy pushed in | Upstream → SGNL | **scim** (entity push) |

If two look plausible, apply the tiebreakers below.

## Tiebreakers

1. **Is the domain "users" or "groups"?**
   - Yes → SCIM entity push is an option (`/Users` and `/Groups` only — see
     the limitation section).
   - No → SCIM entity push is **not** available for this resource type.
     Pick `eventpush` (state transitions) or `polling` (full-state snapshots).
2. **Is the state discrete transitions or a continuously polled snapshot?**
   - Discrete transitions ("door opened", "pickup collected", "ticket
     closed") → `eventpush`.
   - Whole-collection snapshot ("list all employees", "list all map
     fixtures") → `polling`.
3. **Can you run a long-lived process that speaks gRPC?**
   - Yes and the upstream doesn't push → `polling`.
   - No, but upstream can POST JSON → `eventpush`.

## Polling (custom adapter)

- SGNL pulls from your API on a schedule (`defaultSyncFrequency`).
- Requires a **custom gRPC adapter** implementing
  `sgnl.adapter.v1.Adapter.GetPage` ([protocol details](ADAPTER_PROTOCOL.md)).
- YAML uses `auth:` (oAuth2 client creds, basic, or bearer).
- Use this for first-party APIs, BambooHR-style REST sources, the
  cssDOOM map SoR, or any service without SCIM/webhooks.
- **Use when**: you need SGNL to reflect a full collection (every door,
  every employee, every policy) that your process can enumerate on
  request. The adapter returns pages of *current state*, not events.
- Reference: [Custom Adapter docs](https://help.sgnl.ai/articles/systems-of-record/creating-and-configuring-custom-adapter/).

## Event Push (no adapter)

- External system POSTs JSON events to a SGNL-issued endpoint:
  `https://{client}.sgnlapis.cloud/events/custom/v1/{datasourceId}`.
- YAML sets `deliveryMethod: eventPush`, `pushType: Custom`, plus
  `pushEventsPath` selecting the events array within the inbound payload.
- Each entity declares `externalId: <type-string>` and
  `pushExternalId: <JSONPath>` so SGNL can route each event.
- **Use when**: your source produces discrete, typed state-change events
  and you want SGNL to index them by subject. Okta Event Hooks, Azure
  Event Subscriptions, JIRA webhooks, Stripe events, cssDOOM game-state
  transitions (door/lift/pickup/actor state).
- **Prefer over SCIM** for any non-user/group resource type.
- Reference: [Event Push docs](https://help.sgnl.ai/articles/systems-of-record/creating-and-configuring-event-push/)
  and [event reference](EVENT_PUSH_REFERENCE.md).

## SCIM 2.0 (standard adapter)

- Uses SGNL's built-in SCIM 2.0 adapter; no custom code.
- For ingestion: SGNL pulls SCIM resources from the upstream IdP/HR.
- For pushing INTO SGNL: set `deliveryMethod: entityPush` and
  `pushType: SCIM2.0`. The SoR exposes an endpoint your service POSTs
  SCIM resources to.
- **Use when**: the resource type is `User` or `Group` (see limitation).
- Reference: [SCIM SoR docs](https://help.sgnl.ai/articles/systems-of-record/creating-and-configuring-scim/).

### ⚠ SCIM 2.0 Entity Push limitation — `/Users` and `/Groups` only

SGNL's SCIM 2.0 Entity Push endpoint **only accepts SCIM operations
against `/Users` and `/Groups`**. The built-in adapter has no notion of
custom resource types; POSTs/PUTs to paths like `/Doors`, `/Actors`,
`/Pickups`, `/Players`, or any other custom endpoint are rejected.

Implications when picking `scim`:

- ✅ OK: pushing one SCIM User per human identity / session / player,
  extending it with whatever schemas your domain needs.
- ✅ OK: pushing SCIM Groups that cluster those Users (roles, squads,
  tenants).
- ❌ NOT OK: pushing one resource per in-world entity (door, lift,
  pickup, ticket, server, device). That belongs in **eventpush**
  (discrete state changes) or **polling** (full-collection enumeration).

If you find yourself inventing a SCIM resource type that isn't User or
Group, **switch to Event Push** (`deliveryMethod: eventPush`,
`pushType: Custom`) and model each state transition as a typed event
keyed by `$.subject`.

## Heuristics the skill uses

When `detect_project.py` finds:

- An OpenAPI / REST handler tree → suggest **polling**.
- Webhook handlers / `events/` directory → suggest **eventpush**.
- A SCIM client (`scim`-named files, `userName` attributes) targeting
  `/Users` or `/Groups` only → suggest **scim**.
- Any non-user/group domain entities → suggest **eventpush** over SCIM.
- Otherwise the skill asks the user via `AskQuestion`.
