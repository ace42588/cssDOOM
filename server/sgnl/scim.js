/**
 * SCIM push — per-entity, server-side.
 *
 * Mirrors the authoritative game state into a SCIM 2.0 endpoint as one
 * resource per entity (player, AI actor, door, lift, crusher, pickup).
 * Each resource's `userName` matches the `id` the SGNL gRPC map adapter
 * emits for the same entity, so decision engines can cross-reference
 * static and dynamic state without a join.
 *
 * Dispatch model:
 *   - Engine events (pickup collected, door toggled, damage taken, …)
 *     call `markEntityDirty(kind, id)` / `markPlayerDirty(sessionId)`.
 *   - `tickScimDispatch(now)` sweeps the dirty set and calls a per-kind
 *     snapshotter for every dirty id. Each entity has its own 1Hz rate
 *     limit (`lastSentAt`) and content-hash dedupe (`lastHash`) — if an
 *     entity's snapshot matches the last one we sent, no PUT is issued.
 *   - The legacy 5-second heartbeat is gone: no state change means no
 *     network traffic. Position / AI sweep is handled by rehashing the
 *     Player + Actor snapshots once per second (see `tickScimHeartbeat`).
 *
 * Env (set in repo-root `.env` or the shell):
 *   SCIM_PUSH_URL       — base URL for SCIM (`/Users` appended)
 *   SCIM_BEARER_TOKEN   — Bearer token for Authorization header
 */

import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';
import { player, state } from '../../src/game/state.js';

loadEnv({
    path: join(dirname(fileURLToPath(import.meta.url)), '../../.env'),
    quiet: true,
});

const SCIM_CORE_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const PLAYER_SCHEMA = 'urn:cssdoom:params:scim:schemas:extension:player:2.0:Player';
const ACTOR_SCHEMA = 'urn:cssdoom:params:scim:schemas:extension:actor:2.0:Actor';
const DOOR_SCHEMA = 'urn:cssdoom:params:scim:schemas:extension:door:2.0:Door';
const LIFT_SCHEMA = 'urn:cssdoom:params:scim:schemas:extension:lift:2.0:Lift';
const CRUSHER_SCHEMA = 'urn:cssdoom:params:scim:schemas:extension:crusher:2.0:Crusher';
const PICKUP_SCHEMA = 'urn:cssdoom:params:scim:schemas:extension:pickup:2.0:Pickup';
const KEY_SCHEMA = 'urn:cssdoom:params:scim:schemas:extension:key:2.0:Key';

const RATE_LIMIT_MS = 1000;
// How often to resample continuous (position / AI) state even when no
// discrete event flagged it dirty.
const SWEEP_INTERVAL_MS = 1000;

const KEY_TYPE_META = {
    5: { keyName: 'blue-card', color: 'blue', material: 'card' },
    6: { keyName: 'yellow-card', color: 'yellow', material: 'card' },
    13: { keyName: 'red-card', color: 'red', material: 'card' },
    38: { keyName: 'red-skull', color: 'red', material: 'skull' },
    39: { keyName: 'yellow-skull', color: 'yellow', material: 'skull' },
    40: { keyName: 'blue-skull', color: 'blue', material: 'skull' },
};

// ── Module-local state ─────────────────────────────────────────────────

let scimBaseUrl = '';
let scimToken = '';
let scimEnabled = false;
let scimInitialized = false;

let currentMapName = 'E1M1';
let correlationId = '';

/**
 * Per-entity bookkeeping keyed by canonical id (e.g. `door:E1M1:42`).
 *   {
 *     kind,           // 'player' | 'actor' | 'door' | 'lift' | ...
 *     resourceId,     // SCIM id assigned by the server (null before create)
 *     lastHash,       // JSON hash of the last payload we PUT
 *     lastSentAt,     // Date.now() when we last PUT
 *     dirty,          // pending update requested
 *     creating,       // POST /Users in flight
 *   }
 */
const entityState = new Map();

/** Active player sessions. Single-player uses the default 'local' id. */
const playerSessions = new Map();

let sweepClock = 0;
let pushInFlight = false;
let pushQueued = false;

// ── Utils ──────────────────────────────────────────────────────────────

function normalizeBaseUrl(url) {
    return url.replace(/\/+$/, '');
}

function toSortedArray(values) {
    return [...values].sort((a, b) => (a > b ? 1 : a < b ? -1 : 0));
}

function nowIsoString() {
    return new Date().toISOString();
}

function ensureEntry(kind, id) {
    let entry = entityState.get(id);
    if (!entry) {
        entry = {
            kind,
            resourceId: null,
            lastHash: '',
            lastSentAt: 0,
            dirty: true,
            creating: false,
        };
        entityState.set(id, entry);
    }
    return entry;
}

// ── Snapshot builders ──────────────────────────────────────────────────

function snapshotPlayer(sessionId) {
    const session = playerSessions.get(sessionId) || { sessionId };
    return {
        schemas: [SCIM_CORE_USER_SCHEMA, PLAYER_SCHEMA],
        userName: `player:${sessionId}`,
        active: !player.isDead,
        [PLAYER_SCHEMA]: {
            sessionId,
            correlationId,
            mapName: currentMapName,
            displayName: session.displayName || 'Doom Marine',
            position: { x: player.x, y: player.y, z: player.z, angle: player.angle },
            vitals: {
                health: player.health,
                armor: player.armor,
                armorType: player.armorType,
                isDead: Boolean(player.isDead),
            },
            ammo: { ...player.ammo },
            maxAmmo: { ...player.maxAmmo },
            inventory: {
                hasBackpack: Boolean(player.hasBackpack),
                currentWeapon: player.currentWeapon,
                ownedWeapons: toSortedArray(player.ownedWeapons),
                collectedKeys: toSortedArray(player.collectedKeys),
            },
            powerups: Object.entries(player.powerups).map(([name, remainingSeconds]) => ({
                name, remainingSeconds,
            })),
            updatedAt: nowIsoString(),
        },
    };
}

function snapshotActor(id, thing) {
    return {
        schemas: [SCIM_CORE_USER_SCHEMA, ACTOR_SCHEMA],
        userName: id,
        active: !thing.isDead,
        [ACTOR_SCHEMA]: {
            actorId: id,
            mapName: currentMapName,
            thingIndex: thing.thingIndex,
            mapThingIndex: thing.mapThingIndex,
            type: thing.type,
            x: thing.x,
            y: thing.y,
            z: thing.z ?? thing.floorHeight ?? 0,
            hp: thing.hp,
            isDead: Boolean(thing.isDead),
            aiState: thing.aiState || null,
            possessedBy: thing.possessingSessionId || null,
            updatedAt: nowIsoString(),
        },
    };
}

function snapshotDoor(id, door) {
    return {
        schemas: [SCIM_CORE_USER_SCHEMA, DOOR_SCHEMA],
        userName: id,
        active: true,
        [DOOR_SCHEMA]: {
            doorId: id,
            mapName: currentMapName,
            sectorIndex: door.sectorIndex,
            open: Boolean(door.open),
            passable: Boolean(door.passable),
            keyRequired: door.keyRequired || null,
            pendingRequests: Array.isArray(door.doorEntity?.pendingRequests)
                ? door.doorEntity.pendingRequests.length
                : 0,
            updatedAt: nowIsoString(),
        },
    };
}

function snapshotLift(id, lift) {
    return {
        schemas: [SCIM_CORE_USER_SCHEMA, LIFT_SCHEMA],
        userName: id,
        active: true,
        [LIFT_SCHEMA]: {
            liftId: id,
            mapName: currentMapName,
            sectorIndex: lift.sectorIndex,
            tag: Number.isFinite(lift.tag) ? lift.tag : null,
            currentHeight: lift.currentHeight,
            targetHeight: lift.targetHeight,
            lowerHeight: lift.lowerHeight,
            upperHeight: lift.upperHeight,
            moving: Boolean(lift.moving),
            oneWay: Boolean(lift.oneWay),
            updatedAt: nowIsoString(),
        },
    };
}

function snapshotCrusher(id, crusher) {
    return {
        schemas: [SCIM_CORE_USER_SCHEMA, CRUSHER_SCHEMA],
        userName: id,
        active: true,
        [CRUSHER_SCHEMA]: {
            crusherId: id,
            mapName: currentMapName,
            sectorIndex: crusher.sectorIndex,
            active: Boolean(crusher.active),
            direction: crusher.direction,
            currentHeight: crusher.currentHeight,
            topHeight: crusher.topHeight,
            crushHeight: crusher.crushHeight,
            damageTimer: crusher.damageTimer,
            updatedAt: nowIsoString(),
        },
    };
}

function snapshotPickup(id, thing, kind) {
    const isKey = kind === 'key';
    const schema = isKey ? KEY_SCHEMA : PICKUP_SCHEMA;
    const keyMeta = KEY_TYPE_META[thing.type];
    return {
        schemas: [SCIM_CORE_USER_SCHEMA, schema],
        userName: id,
        active: !thing.collected,
        [schema]: {
            pickupId: id,
            mapName: currentMapName,
            thingIndex: thing.thingIndex,
            mapThingIndex: thing.mapThingIndex,
            type: thing.type,
            x: thing.x,
            y: thing.y,
            collected: Boolean(thing.collected),
            ...(isKey && keyMeta
                ? {
                      keyName: keyMeta.keyName,
                      color: keyMeta.color,
                      material: keyMeta.material,
                  }
                : {}),
            updatedAt: nowIsoString(),
        },
    };
}

// ── Entity resolution ──────────────────────────────────────────────────

/**
 * Find the live game-state object for a given canonical id, or return
 * null if the entity has been removed (e.g. after a map change).
 */
function resolveEntity(kind, id) {
    switch (kind) {
        case 'player': {
            // id is expected to be `player:<sessionId>`
            const sessionId = id.slice('player:'.length);
            return playerSessions.has(sessionId) ? { sessionId } : null;
        }
        case 'door': {
            const sectorIndex = parseSectorIndex(id);
            if (!Number.isFinite(sectorIndex)) return null;
            return state.doorState.get(sectorIndex) || null;
        }
        case 'lift': {
            const sectorIndex = parseSectorIndex(id);
            if (!Number.isFinite(sectorIndex)) return null;
            return state.liftState.get(sectorIndex) || null;
        }
        case 'crusher': {
            const sectorIndex = parseSectorIndex(id);
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

function parseSectorIndex(id) {
    return parseTrailingInt(id);
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

function buildSnapshot(kind, id, entity) {
    switch (kind) {
        case 'player':  return snapshotPlayer(entity.sessionId);
        case 'actor':   return snapshotActor(id, entity);
        case 'door':    return snapshotDoor(id, entity);
        case 'lift':    return snapshotLift(id, entity);
        case 'crusher': return snapshotCrusher(id, entity);
        case 'pickup':  return snapshotPickup(id, entity, 'pickup');
        case 'key':     return snapshotPickup(id, entity, 'key');
        default:        return null;
    }
}

// ── HTTP ───────────────────────────────────────────────────────────────

/**
 * Perform a SCIM HTTP request. Returns a result object:
 *   { ok, status, body }
 *
 * `body` is the parsed JSON response (or `null` on parse/network failure).
 * Non-2xx responses are logged once by the caller — callers that want to
 * swallow specific statuses (e.g. 409 on POST so they can recover via a
 * GET-by-userName lookup) can inspect `status` directly without double
 * logging.
 */
async function scimRequest(method, path, body, { quietStatuses = [] } = {}) {
    try {
        const response = await fetch(`${scimBaseUrl}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${scimToken}`,
                'Content-Type': 'application/scim+json',
                Accept: 'application/scim+json, application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        let parsed = null;
        try { parsed = await response.json(); } catch { parsed = null; }
        if (!response.ok && !quietStatuses.includes(response.status)) {
            const detail = parsed ? JSON.stringify(parsed) : '';
            // eslint-disable-next-line no-console
            console.warn(`[scim] ${method} ${path} failed`, response.status, detail);
        }
        return { ok: response.ok, status: response.status, body: parsed };
    } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(`[scim] ${method} ${path} error`, error?.message || error);
        return { ok: false, status: 0, body: null };
    }
}

/**
 * SCIM servers don't let us PUT a resource we haven't created, but they
 * do let us look one up by `userName`. When a POST fails with 409 it
 * usually means the resource already exists from a previous run — fetch
 * its id and adopt it so subsequent PUTs hit the right document.
 */
async function findResourceIdByUserName(userName) {
    const filter = `userName eq "${String(userName).replace(/"/g, '\\"')}"`;
    const query = `filter=${encodeURIComponent(filter)}&count=1`;
    const { ok, body } = await scimRequest('GET', `/Users?${query}`);
    if (!ok || !body) return null;
    const resources = Array.isArray(body.Resources) ? body.Resources : [];
    const first = resources[0];
    return first?.id || null;
}

async function putEntity(id, entry, payload) {
    // Create on first send; PUT subsequent updates.
    if (!entry.resourceId) {
        if (entry.creating) return false;
        entry.creating = true;
        try {
            // Swallow 409 so we can recover via a userName lookup
            // without spamming the console.
            const create = await scimRequest('POST', '/Users', payload, {
                quietStatuses: [409],
            });
            if (create.ok && create.body) {
                entry.resourceId = create.body.id || id;
            } else if (create.status === 409) {
                // Resource already exists on the SCIM server — adopt it.
                const existingId = await findResourceIdByUserName(payload.userName);
                if (!existingId) return false;
                entry.resourceId = existingId;
                // Fall through to the PUT below so we actually persist
                // the current snapshot.
            } else {
                return false;
            }
        } finally {
            entry.creating = false;
        }
    }
    const update = await scimRequest(
        'PUT',
        `/Users/${encodeURIComponent(entry.resourceId)}`,
        payload,
    );
    return update.ok;
}

// ── Dispatch loop ──────────────────────────────────────────────────────

async function dispatchDirty(now) {
    if (!scimEnabled || !scimInitialized) return;
    if (pushInFlight) { pushQueued = true; return; }
    pushInFlight = true;
    try {
        for (const [id, entry] of entityState) {
            if (!entry.dirty) continue;
            if (entry.creating) continue;
            if (entry.lastSentAt && now - entry.lastSentAt < RATE_LIMIT_MS) continue;

            const live = resolveEntity(entry.kind, id);
            if (!live) {
                // Entity no longer exists (e.g. map change). Drop it so
                // stale snapshots don't keep trying to resolve.
                entry.dirty = false;
                continue;
            }

            const payload = buildSnapshot(entry.kind, id, live);
            if (!payload) { entry.dirty = false; continue; }

            const hash = JSON.stringify(payload);
            if (hash === entry.lastHash) {
                entry.dirty = false;
                continue;
            }

            const ok = await putEntity(id, entry, payload);
            if (!ok) continue;
            entry.lastHash = hash;
            entry.lastSentAt = Date.now();
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

/**
 * Register / unregister a player session so the SCIM module emits a
 * Player resource for it. Single-player callers can rely on the default
 * 'local' session installed by `initScimPush`.
 */
export function registerScimPlayer(sessionId, meta = {}) {
    if (!sessionId) return;
    playerSessions.set(sessionId, { sessionId, ...meta });
    const id = `player:${sessionId}`;
    ensureEntry('player', id).dirty = true;
}

export function unregisterScimPlayer(sessionId) {
    if (!sessionId) return;
    playerSessions.delete(sessionId);
    const id = `player:${sessionId}`;
    const entry = entityState.get(id);
    if (entry) entry.dirty = false;
}

/** Mark a single entity for a SCIM push on the next dispatch tick. */
export function markEntityDirty(kind, id) {
    if (!kind || !id) return;
    ensureEntry(kind, id).dirty = true;
}

/** Convenience wrapper: mark the given (or default) player session. */
export function markPlayerDirty(sessionId) {
    const id = sessionId ? `player:${sessionId}` : defaultPlayerId();
    if (!id) return;
    ensureEntry('player', id).dirty = true;
}

function defaultPlayerId() {
    if (playerSessions.size === 0) return '';
    // Single-player or first-registered session.
    return `player:${playerSessions.keys().next().value}`;
}

/**
 * Signal that a new map was loaded. Rebaselines bookkeeping: anything
 * bound to the old map is dropped, players stay, and we flush the new
 * baseline ASAP.
 */
export function markMapChanged(mapName) {
    if (typeof mapName === 'string' && mapName.length > 0) {
        currentMapName = mapName;
    }
    for (const [id, entry] of entityState) {
        if (entry.kind === 'player') {
            entry.dirty = true;
            continue;
        }
        // Every other entity's id is scoped to a map — drop stale ones;
        // the engine will remark fresh entities via `markEntityDirty`.
        const parts = id.split(':');
        if (parts.length >= 3 && parts[1] !== currentMapName) {
            entityState.delete(id);
        } else {
            entry.dirty = true;
        }
    }
    sweepClock = 0;
}

/**
 * Legacy name retained for `services.setMapName` wiring.
 * Prefer `markMapChanged` directly from engine code.
 */
export function setScimMapName(mapName) {
    markMapChanged(mapName);
}

/** Force a dispatch pass right now (respecting per-entity 1Hz limits). */
export async function flushScimNow() {
    if (!scimEnabled || !scimInitialized) return;
    await dispatchDirty(Date.now());
}

/**
 * Frame heartbeat: resample continuous (player + AI actor) state at 1Hz
 * so position / HP changes reach SCIM even when no discrete event fired.
 * Discrete events still go through `markEntityDirty` — those flush on
 * the next dispatch pass (≤ 1s latency).
 */
export function tickScimHeartbeat(deltaTime) {
    if (!scimEnabled || !scimInitialized) return;
    sweepClock += (deltaTime || 0) * 1000;
    if (sweepClock >= SWEEP_INTERVAL_MS) {
        sweepClock = 0;
        // Players
        for (const sessionId of playerSessions.keys()) {
            ensureEntry('player', `player:${sessionId}`).dirty = true;
        }
        // AI actors — every thing with an `ai` block
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
 * Bootstrap SCIM push. Idempotent. If `SCIM_PUSH_URL` / `SCIM_BEARER_TOKEN`
 * are not set, SCIM is disabled and all dirty calls become no-ops.
 *
 * Installs a default `local` player session so single-player runs emit
 * a Player resource without having to register one.
 */
export async function initScimPush(initialMapName = 'E1M1') {
    scimBaseUrl = normalizeBaseUrl(process.env.SCIM_PUSH_URL || '');
    scimToken = process.env.SCIM_BEARER_TOKEN || '';
    scimEnabled = Boolean(scimBaseUrl && scimToken);
    if (!scimEnabled) return;

    correlationId = randomUUID();
    currentMapName = initialMapName || 'E1M1';
    scimInitialized = true;

    // Default single-player session — multiplayer callers overwrite via
    // `registerScimPlayer`.
    registerScimPlayer('local', { displayName: 'Doom Marine' });

    await dispatchDirty(Date.now());
}
