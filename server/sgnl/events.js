/**
 * SGNL Event Push client — server-side.
 *
 * SGNL's SCIM 2.0 Entity Push only accepts `/Users` and `/Groups`; it
 * cannot host per-entity resource types for doors, lifts, crushers,
 * pickups, keys, or AI actors. Event Push fills that gap: the cssDOOM
 * server POSTs typed JSON events to the endpoint SGNL issues at SoR
 * creation time, and each event carries a `subject` that matches the
 * canonical asset id the SCIM User resource and SGNL map adapter use.
 *
 * Wire:
 *   POST <SGNL_EVENTS_URL>
 *   Authorization: Bearer <SGNL_EVENTS_TOKEN>
 *   Content-Type: application/json
 *   Body: { "events": [ { "id": "uuid", "type": "DoorState",
 *                         "subject": "door:E1M1:42", ... }, ... ] }
 *
 * Dispatch model (mirrors SCIM):
 *   - Engine hooks call `markEntityDirty(kind, id)` on every meaningful
 *     state transition.
 *   - `tickEventsHeartbeat(dt)` resamples continuous state (AI actor
 *     position / aiState) at 1Hz.
 *   - `dispatchDirty()` rebuilds each dirty entity's snapshot, hashes
 *     it, and only emits an event if the hash changed. No state
 *     change → no network traffic.
 *
 * Env:
 *   SGNL_EVENTS_URL    — full Event Push URL issued by SGNL
 *                        (https://{client}.sgnlapis.cloud/events/custom/v1/{datasourceId})
 *   SGNL_EVENTS_TOKEN  — Bearer token SGNL issued for that endpoint
 */

import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';
import { state } from '../../src/game/state.js';

loadEnv({
    path: join(dirname(fileURLToPath(import.meta.url)), '../../.env'),
    quiet: true,
});

// Literal `$.type` values that bind each event to its SoR entity. Must
// match the `externalId`s in public/sgnl/events-sor.yaml.
const EVENT_TYPE = {
    door: 'DoorState',
    lift: 'LiftState',
    crusher: 'CrusherState',
    pickup: 'PickupState',
    key: 'KeyState',
    actor: 'ActorState',
};

const RATE_LIMIT_MS = 1000;
const SWEEP_INTERVAL_MS = 1000;
// Max events per POST. SGNL's Event Push endpoint accepts batched
// arrays; we cap to keep payloads bounded and latency predictable.
const MAX_BATCH_SIZE = 50;

const KEY_TYPE_META = {
    5: { keyName: 'blue-card', color: 'blue', material: 'card' },
    6: { keyName: 'yellow-card', color: 'yellow', material: 'card' },
    13: { keyName: 'red-card', color: 'red', material: 'card' },
    38: { keyName: 'red-skull', color: 'red', material: 'skull' },
    39: { keyName: 'yellow-skull', color: 'yellow', material: 'skull' },
    40: { keyName: 'blue-skull', color: 'blue', material: 'skull' },
};

// ── Module-local state ─────────────────────────────────────────────────

let eventsUrl = '';
let eventsToken = '';
let eventsEnabled = false;
let eventsInitialized = false;
let eventsFatallyDisabled = false;

let currentMapName = 'E1M1';

/**
 * Per-entity bookkeeping keyed by canonical id (e.g. `door:E1M1:42`).
 *   {
 *     kind,          // 'door' | 'lift' | 'crusher' | 'pickup' | 'key' | 'actor'
 *     lastHash,      // JSON hash of the last event payload we emitted
 *     lastSentAt,    // Date.now() of the last emit
 *     dirty,         // pending emit requested
 *   }
 */
const entityState = new Map();

let sweepClock = 0;
let pushInFlight = false;
let pushQueued = false;

// ── Utils ──────────────────────────────────────────────────────────────

function nowIsoString() {
    return new Date().toISOString();
}

function ensureEntry(kind, id) {
    let entry = entityState.get(id);
    if (!entry) {
        entry = { kind, lastHash: '', lastSentAt: 0, dirty: true };
        entityState.set(id, entry);
    }
    return entry;
}

function parseTrailingInt(id) {
    const parts = String(id).split(':');
    if (parts.length < 2) return NaN;
    return Number(parts[parts.length - 1]);
}

function findThingByMapIndex(mapThingIndex) {
    for (const thing of state.things) {
        if (thing.mapThingIndex === mapThingIndex) return thing;
    }
    return null;
}

// ── Entity resolution ──────────────────────────────────────────────────

function resolveEntity(kind, id) {
    switch (kind) {
        case 'door': {
            const sectorIndex = parseTrailingInt(id);
            if (!Number.isFinite(sectorIndex)) return null;
            return state.doorState.get(sectorIndex) || null;
        }
        case 'lift': {
            const sectorIndex = parseTrailingInt(id);
            if (!Number.isFinite(sectorIndex)) return null;
            return state.liftState.get(sectorIndex) || null;
        }
        case 'crusher': {
            const sectorIndex = parseTrailingInt(id);
            if (!Number.isFinite(sectorIndex)) return null;
            return state.crusherState.get(sectorIndex) || null;
        }
        case 'actor':
        case 'pickup':
        case 'key': {
            const mapThingIndex = parseTrailingInt(id);
            if (!Number.isFinite(mapThingIndex)) return null;
            return findThingByMapIndex(mapThingIndex);
        }
        default:
            return null;
    }
}

// ── Event payload builders ─────────────────────────────────────────────

// Every event carries a unique `id`, a routing `type`, an indexed
// `subject`, and a `timestamp`. Kind-specific fields are flat under
// the event root — no nested objects — so SGNL policy JSONPath stays
// simple (`$.open`, `$.keyRequired`, …).

function eventDoor(id, door) {
    return {
        type: EVENT_TYPE.door,
        subject: id,
        mapName: currentMapName,
        sectorIndex: door.sectorIndex,
        open: Boolean(door.open),
        passable: Boolean(door.passable),
        keyRequired: door.keyRequired || null,
        pendingRequests: Array.isArray(door.doorEntity?.pendingRequests)
            ? door.doorEntity.pendingRequests.length
            : 0,
    };
}

function eventLift(id, lift) {
    return {
        type: EVENT_TYPE.lift,
        subject: id,
        mapName: currentMapName,
        sectorIndex: lift.sectorIndex,
        tag: Number.isFinite(lift.tag) ? lift.tag : null,
        currentHeight: lift.currentHeight,
        targetHeight: lift.targetHeight,
        lowerHeight: lift.lowerHeight,
        upperHeight: lift.upperHeight,
        moving: Boolean(lift.moving),
        oneWay: Boolean(lift.oneWay),
    };
}

function eventCrusher(id, crusher) {
    return {
        type: EVENT_TYPE.crusher,
        subject: id,
        mapName: currentMapName,
        sectorIndex: crusher.sectorIndex,
        active: Boolean(crusher.active),
        direction: crusher.direction,
        currentHeight: crusher.currentHeight,
        topHeight: crusher.topHeight,
        crushHeight: crusher.crushHeight,
        damageTimer: crusher.damageTimer,
    };
}

function eventPickup(id, thing, kind) {
    const isKey = kind === 'key';
    const keyMeta = isKey ? KEY_TYPE_META[thing.type] : null;
    const thingIndex = Number.isFinite(thing.thingIndex)
        ? thing.thingIndex
        : thing.mapThingIndex;
    const payload = {
        type: isKey ? EVENT_TYPE.key : EVENT_TYPE.pickup,
        subject: id,
        mapName: currentMapName,
        thingIndex,
        mapThingIndex: thing.mapThingIndex,
        pickupType: thing.type,
        x: thing.x,
        y: thing.y,
        collected: Boolean(thing.collected),
        collectedBy: thing.collectedBySessionId
            ? `player:${thing.collectedBySessionId}`
            : null,
    };
    if (keyMeta) {
        payload.keyName = keyMeta.keyName;
        payload.color = keyMeta.color;
        payload.material = keyMeta.material;
    }
    return payload;
}

function eventActor(id, thing) {
    const thingIndex = Number.isFinite(thing.thingIndex)
        ? thing.thingIndex
        : thing.mapThingIndex;
    return {
        type: EVENT_TYPE.actor,
        subject: id,
        mapName: currentMapName,
        thingIndex,
        mapThingIndex: thing.mapThingIndex,
        actorType: thing.type,
        x: thing.x,
        y: thing.y,
        z: thing.z ?? thing.floorHeight ?? 0,
        hp: thing.hp,
        isDead: Boolean(thing.isDead),
        aiState: thing.aiState || null,
        possessedBy: thing.possessingSessionId
            ? `player:${thing.possessingSessionId}`
            : null,
    };
}

function buildEvent(kind, id, entity) {
    switch (kind) {
        case 'door':    return eventDoor(id, entity);
        case 'lift':    return eventLift(id, entity);
        case 'crusher': return eventCrusher(id, entity);
        case 'pickup':  return eventPickup(id, entity, 'pickup');
        case 'key':     return eventPickup(id, entity, 'key');
        case 'actor':   return eventActor(id, entity);
        default:        return null;
    }
}

// ── HTTP ───────────────────────────────────────────────────────────────

async function postEvents(events) {
    if (eventsFatallyDisabled || events.length === 0) return false;
    try {
        const response = await fetch(eventsUrl, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${eventsToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ events }),
        });
        if (!response.ok) {
            let detail = '';
            try { detail = await response.text(); } catch { /* ignore */ }
            // eslint-disable-next-line no-console
            console.warn(`[events] POST failed`, response.status, detail);
            if (response.status >= 400 && response.status < 500) {
                disableEventsFatally(`POST → ${response.status}`);
            }
            return false;
        }
        return true;
    } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('[events] POST error', error?.message || error);
        return false;
    }
}

function disableEventsFatally(reason) {
    if (eventsFatallyDisabled) return;
    eventsFatallyDisabled = true;
    for (const entry of entityState.values()) {
        entry.dirty = false;
    }
    pushQueued = false;
    // eslint-disable-next-line no-console
    console.warn(
        `[events] disabling Event Push until restart (reason: ${reason})`,
    );
}

// ── Dispatch loop ──────────────────────────────────────────────────────

async function dispatchDirty(now) {
    if (!eventsEnabled || !eventsInitialized || eventsFatallyDisabled) return;
    if (pushInFlight) { pushQueued = true; return; }
    pushInFlight = true;
    try {
        const batch = [];
        const committed = [];

        for (const [id, entry] of entityState) {
            if (!entry.dirty) continue;
            if (entry.lastSentAt && now - entry.lastSentAt < RATE_LIMIT_MS) continue;

            const live = resolveEntity(entry.kind, id);
            if (!live) {
                entry.dirty = false;
                continue;
            }

            const body = buildEvent(entry.kind, id, live);
            if (!body) { entry.dirty = false; continue; }

            const hash = JSON.stringify(body);
            if (hash === entry.lastHash) {
                entry.dirty = false;
                continue;
            }

            batch.push({
                id: randomUUID(),
                timestamp: nowIsoString(),
                ...body,
            });
            committed.push({ entry, hash });

            if (batch.length >= MAX_BATCH_SIZE) break;
        }

        if (batch.length === 0) return;

        const ok = await postEvents(batch);
        if (!ok) return;

        const sentAt = Date.now();
        for (const { entry, hash } of committed) {
            entry.lastHash = hash;
            entry.lastSentAt = sentAt;
            entry.dirty = false;
        }
    } finally {
        pushInFlight = false;
        if (pushQueued) {
            pushQueued = false;
            void dispatchDirty(Date.now());
        }
    }
}

// ── Public API ─────────────────────────────────────────────────────────

/** Mark a single entity for an event emit on the next dispatch tick. */
export function markEntityDirty(kind, id) {
    if (!kind || !id) return;
    if (kind === 'player') return; // players go through SCIM /Users
    if (!EVENT_TYPE[kind]) return;
    ensureEntry(kind, id).dirty = true;
}

/**
 * New map loaded: drop bookkeeping for entities scoped to the old map
 * and rebaseline. The engine will remark fresh entities on its own.
 */
export function markMapChanged(mapName) {
    if (typeof mapName === 'string' && mapName.length > 0) {
        currentMapName = mapName;
    }
    for (const [id, entry] of entityState) {
        const parts = id.split(':');
        if (parts.length >= 3 && parts[1] !== currentMapName) {
            entityState.delete(id);
        } else {
            entry.dirty = true;
        }
    }
    sweepClock = 0;
}

/** Force a dispatch pass right now (respecting per-entity 1Hz limits). */
export async function flushEventsNow() {
    if (!eventsEnabled || !eventsInitialized || eventsFatallyDisabled) return;
    await dispatchDirty(Date.now());
}

/**
 * Frame heartbeat: resample continuous AI-actor state at 1Hz so
 * position / aiState changes reach SGNL even without a discrete event.
 */
export function tickEventsHeartbeat(deltaTime) {
    if (!eventsEnabled || !eventsInitialized || eventsFatallyDisabled) return;
    sweepClock += (deltaTime || 0) * 1000;
    if (sweepClock >= SWEEP_INTERVAL_MS) {
        sweepClock = 0;
        for (const thing of state.things) {
            if (!thing.ai) continue;
            if (!Number.isFinite(thing.mapThingIndex)) continue;
            const id = `actor:${currentMapName}:${thing.mapThingIndex}`;
            ensureEntry('actor', id).dirty = true;
        }
    }
    void dispatchDirty(Date.now());
}

/**
 * Bootstrap Event Push. Idempotent. Missing env → no-op (dirty calls
 * are dropped). Unlike SCIM, there's no default session to install:
 * events only fire when the engine marks an entity dirty.
 */
export async function initEventsPush(initialMapName = 'E1M1') {
    eventsUrl = (process.env.SGNL_EVENTS_URL || '').trim();
    eventsToken = (process.env.SGNL_EVENTS_TOKEN || '').trim();
    eventsEnabled = Boolean(eventsUrl && eventsToken);
    if (!eventsEnabled) return;
    currentMapName = initialMapName || 'E1M1';
    eventsInitialized = true;
}
