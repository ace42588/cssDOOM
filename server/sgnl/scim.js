/**
 * SCIM 2.0 User push — server-side.
 *
 * SGNL's SCIM 2.0 Entity Push only accepts `/Users` and `/Groups`. The
 * cssDOOM server therefore treats SCIM as a pure player-session mirror:
 * one SCIM User per connected session (`userName = player:<sessionId>`).
 * Every other mutable game entity (doors, lifts, crushers, pickups,
 * keys, AI actors) is pushed through the Event Push channel — see
 * `server/sgnl/events.js`.
 *
 * Dispatch model:
 *   - Session register / lifecycle events and engine hooks call
 *     `markPlayerDirty(sessionId)`.
 *   - `tickScimHeartbeat(dt)` resamples continuously-changing state
 *     (position, health, ammo) at 1Hz so gradual changes reach SCIM.
 *   - `dispatchDirty()` sweeps the dirty set, rebuilds each player's
 *     snapshot, hashes it, and PUTs only when the hash changed.
 *   - On the first send for a session we POST /Users; subsequent
 *     updates PUT /Users/{id}. 409 on POST falls back to a
 *     `userName eq` GET so we adopt an existing resource id.
 *
 * Env (set in repo-root `.env` or the shell):
 *   SCIM_PUSH_URL       — base URL (SGNL appends `/Users`)
 *   SCIM_BEARER_TOKEN   — Bearer token SGNL issued for this SoR
 */

import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';
import { player } from '../../src/game/state.js';

loadEnv({
    path: join(dirname(fileURLToPath(import.meta.url)), '../../.env'),
    quiet: true,
});

// Single SCIM resource type (User); the domain-specific attributes
// hang off a cssDOOM schema URN listed alongside the SCIM core User
// schema. Groups are not used by this SoR.
const SCIM_CORE_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const PLAYER_SCHEMA = 'urn:cssdoom:params:scim:schemas:Player';
const USERS_ENDPOINT = '/Users';

const RATE_LIMIT_MS = 1000;
// How often to resample continuous state (position / vitals) even when
// no discrete event flagged it dirty.
const SWEEP_INTERVAL_MS = 1000;

// ── Module-local state ─────────────────────────────────────────────────

let scimBaseUrl = '';
let scimToken = '';
let scimEnabled = false;
let scimInitialized = false;
// Latches true on the first unrecoverable 4xx. Stops retry spam against
// a broken peer until the process restarts.
let scimFatallyDisabled = false;

let currentMapName = 'E1M1';
let correlationId = '';

/**
 * Per-session bookkeeping keyed by sessionId.
 *   {
 *     sessionId,
 *     displayName,
 *     resourceId,     // SCIM id assigned by /Users POST (null before create)
 *     lastHash,       // JSON hash of the last payload we PUT
 *     lastSentAt,     // Date.now() when we last PUT
 *     dirty,          // pending update requested
 *     creating,       // POST /Users in flight
 *   }
 */
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

function ensureSession(sessionId, meta = {}) {
    let entry = playerSessions.get(sessionId);
    if (!entry) {
        entry = {
            sessionId,
            displayName: meta.displayName || 'Doom Marine',
            resourceId: null,
            lastHash: '',
            lastSentAt: 0,
            dirty: true,
            creating: false,
        };
        playerSessions.set(sessionId, entry);
    } else if (meta.displayName) {
        entry.displayName = meta.displayName;
    }
    return entry;
}

// ── Snapshot builder ───────────────────────────────────────────────────

// Single player snapshot. Nested objects (position, vitals, ammo, …)
// stay nested because the SoR addresses them via JSONPath
// (`$.position.x`); `powerups` is a multi-valued nested attribute,
// modelled as a Powerup child entity in the SoR.
function snapshotPlayer(session) {
    const userName = `player:${session.sessionId}`;
    return {
        id: userName,
        schemas: [SCIM_CORE_USER_SCHEMA, PLAYER_SCHEMA],
        userName,
        active: !player.isDead,
        sessionId: session.sessionId,
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
    };
}

// ── HTTP ───────────────────────────────────────────────────────────────

async function scimRequest(method, path, body, { quietStatuses = [] } = {}) {
    if (scimFatallyDisabled) {
        return { ok: false, status: 0, body: null };
    }
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
        const status = response.status;
        const isRecoverable = quietStatuses.includes(status);
        if (!response.ok && !isRecoverable) {
            const detail = parsed ? JSON.stringify(parsed) : '';
            // eslint-disable-next-line no-console
            console.warn(`[scim] ${method} ${path} failed`, status, detail);
        }
        if (status >= 400 && status < 500 && !isRecoverable) {
            disableScimFatally(`${method} ${path} → ${status}`);
        }
        return { ok: response.ok, status, body: parsed };
    } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(`[scim] ${method} ${path} error`, error?.message || error);
        return { ok: false, status: 0, body: null };
    }
}

function disableScimFatally(reason) {
    if (scimFatallyDisabled) return;
    scimFatallyDisabled = true;
    for (const entry of playerSessions.values()) {
        entry.dirty = false;
    }
    pushQueued = false;
    // eslint-disable-next-line no-console
    console.warn(
        `[scim] disabling SCIM push until restart (reason: ${reason})`,
    );
}

/**
 * SCIM servers won't PUT a resource we haven't created. On 409 from a
 * POST the resource already exists (likely from a previous run) — look
 * it up by `userName` and adopt the existing id.
 */
async function findResourceIdByUserName(userName) {
    const filter = `userName eq "${String(userName).replace(/"/g, '\\"')}"`;
    const query = `filter=${encodeURIComponent(filter)}&count=1`;
    const { ok, body } = await scimRequest('GET', `${USERS_ENDPOINT}?${query}`);
    if (!ok || !body) return null;
    const resources = Array.isArray(body.Resources) ? body.Resources : [];
    return resources[0]?.id || null;
}

async function putPlayer(entry, payload) {
    if (!entry.resourceId) {
        if (entry.creating) return false;
        entry.creating = true;
        try {
            const create = await scimRequest('POST', USERS_ENDPOINT, payload, {
                quietStatuses: [409],
            });
            if (create.ok && create.body) {
                entry.resourceId = create.body.id || payload.id;
            } else if (create.status === 409) {
                const existingId = await findResourceIdByUserName(payload.userName);
                if (!existingId) return false;
                entry.resourceId = existingId;
            } else {
                return false;
            }
        } finally {
            entry.creating = false;
        }
    }
    const update = await scimRequest(
        'PUT',
        `${USERS_ENDPOINT}/${encodeURIComponent(entry.resourceId)}`,
        payload,
    );
    return update.ok;
}

// ── Dispatch loop ──────────────────────────────────────────────────────

async function dispatchDirty(now) {
    if (!scimEnabled || !scimInitialized || scimFatallyDisabled) return;
    if (pushInFlight) { pushQueued = true; return; }
    pushInFlight = true;
    try {
        for (const entry of playerSessions.values()) {
            if (!entry.dirty) continue;
            if (entry.creating) continue;
            if (entry.lastSentAt && now - entry.lastSentAt < RATE_LIMIT_MS) continue;

            const payload = snapshotPlayer(entry);
            const hash = JSON.stringify(payload);
            if (hash === entry.lastHash) {
                entry.dirty = false;
                continue;
            }
            const ok = await putPlayer(entry, payload);
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

async function deletePlayer(entry) {
    if (!scimEnabled || !scimInitialized || scimFatallyDisabled) return;
    if (!entry.resourceId) return;
    await scimRequest(
        'DELETE',
        `${USERS_ENDPOINT}/${encodeURIComponent(entry.resourceId)}`,
    );
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Register a player session so the SCIM module emits a User resource
 * for it. Single-player callers can rely on the default 'local' session
 * installed by `initScimPush`.
 */
export function registerScimPlayer(sessionId, meta = {}) {
    if (!sessionId) return;
    const entry = ensureSession(sessionId, meta);
    entry.dirty = true;
}

/**
 * Remove a session from the SCIM SoR. Best-effort DELETE /Users/{id};
 * if the SCIM endpoint is unreachable we simply forget the session
 * locally so we don't keep stale bookkeeping.
 */
export function unregisterScimPlayer(sessionId) {
    if (!sessionId) return;
    const entry = playerSessions.get(sessionId);
    if (!entry) return;
    playerSessions.delete(sessionId);
    void deletePlayer(entry);
}

/** Mark the given (or default) player session dirty. */
export function markPlayerDirty(sessionId) {
    const id = sessionId || defaultSessionId();
    if (!id) return;
    const entry = playerSessions.get(id);
    if (entry) entry.dirty = true;
}

function defaultSessionId() {
    if (playerSessions.size === 0) return '';
    return playerSessions.keys().next().value;
}

/** Signal that a new map was loaded; all sessions need a fresh push. */
export function markMapChanged(mapName) {
    if (typeof mapName === 'string' && mapName.length > 0) {
        currentMapName = mapName;
    }
    for (const entry of playerSessions.values()) {
        entry.dirty = true;
    }
    sweepClock = 0;
}

/** Force a dispatch pass right now (respecting per-session 1Hz limits). */
export async function flushScimNow() {
    if (!scimEnabled || !scimInitialized || scimFatallyDisabled) return;
    await dispatchDirty(Date.now());
}

/**
 * Frame heartbeat: resample continuous player state at 1Hz so gradual
 * changes (position, ammo tick-down) reach SCIM even when no discrete
 * event fired. Discrete events still go through `markPlayerDirty` and
 * flush on the next dispatch pass (≤ 1s latency).
 */
export function tickScimHeartbeat(deltaTime) {
    if (!scimEnabled || !scimInitialized || scimFatallyDisabled) return;
    sweepClock += (deltaTime || 0) * 1000;
    if (sweepClock >= SWEEP_INTERVAL_MS) {
        sweepClock = 0;
        for (const entry of playerSessions.values()) {
            entry.dirty = true;
        }
    }
    void dispatchDirty(Date.now());
}

/**
 * Bootstrap SCIM push. Idempotent. If `SCIM_PUSH_URL` /
 * `SCIM_BEARER_TOKEN` are not set, SCIM is disabled and all dirty
 * calls become no-ops.
 *
 * Installs a default `local` session so single-player runs emit a User
 * resource without explicit registration.
 */
export async function initScimPush(initialMapName = 'E1M1') {
    scimBaseUrl = normalizeBaseUrl(process.env.SCIM_PUSH_URL || '');
    scimToken = process.env.SCIM_BEARER_TOKEN || '';
    scimEnabled = Boolean(scimBaseUrl && scimToken);
    if (!scimEnabled) return;

    correlationId = randomUUID();
    currentMapName = initialMapName || 'E1M1';
    scimInitialized = true;

    registerScimPlayer('local', { displayName: 'Doom Marine' });

    await dispatchDirty(Date.now());
}
