/**
 * Authoritative game world hosted by the server.
 *
 * Responsibilities:
 *   - Install the engine's renderer + audio + services hosts so the core
 *     engine modules run headlessly on Node. The renderer uses the
 *     recording host (each visual intent is buffered) and audio uses its
 *     own recording host (sound names are buffered); both get drained into
 *     the next outgoing snapshot.
 *   - Load the current map (via `loadMapHeadless`, which reads JSON from
 *     disk and then runs the same spawn / spatial-grid / adjacency setup
 *     the browser does).
 *   - Run a fixed-timestep game loop at `TICK_RATE_HZ`, calling
 *     `updateGameMulti(dt, now, sessionInputs)` each tick.
 *   - Build a snapshot after every tick and hand it to `connections.js`
 *     (caller does the actual broadcast — we stay transport-agnostic).
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { setRendererHost } from '../src/renderer/index.js';
import { createRecordingRendererHost } from '../src/renderer/recording-host.js';
import { setAudioHost } from '../src/audio/audio.js';
import { createRecordingAudioHost } from '../src/audio/recording-host.js';
import { setGameServices } from '../src/game/services.js';

import { player, state } from '../src/game/state.js';
import { currentMap } from '../src/data/maps.js';
import { updateGameMulti } from '../src/game/index.js';
import { loadMapHeadless } from '../src/game/lifecycle.js';
import {
    getControlledFor,
    listHumanControlledEntries,
} from '../src/game/possession.js';
import { getThingIndex } from '../src/game/things/registry.js';

import { emptyInput, MSG, ROLE } from './net.js';
import {
    listConnections,
    listPlayerConnections,
} from './connections.js';
import {
    entityId,
    demoteToSpectator,
    pickNewFollowTargetId,
    controlledBodyIsAlive,
    resolveEntity,
    assignOnJoin,
} from './assignment.js';
import { equipWeapon } from '../src/game/combat/weapons.js';
import { fireWeaponFor } from '../src/game/combat/weapons.js';
import { tryOpenDoor, resolveDoorRequest } from '../src/game/mechanics/doors.js';
import { tryUseSwitch } from '../src/game/mechanics/switches.js';
import { getNextMap, getSecretExitMap } from '../src/game/lifecycle.js';
import { possessFor } from '../src/game/possession.js';
import { send } from './connections.js';
import { tickIdleChecks } from './idle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAP_DIR = path.resolve(__dirname, '..', 'public', 'maps');

const TICK_RATE_HZ = 70; // DOOM's native tic rate
const TICK_MS = 1000 / TICK_RATE_HZ;
const SNAPSHOT_DIVISOR = 2; // send snapshots at 35 Hz

let rendererHost = null;
let audioHost = null;
let tickNumber = 0;
let loopTimer = null;
let lastTickTime = 0;
let currentMapData = null;

// ── Host installation ─────────────────────────────────────────────────

export function installEngineHosts() {
    rendererHost = createRecordingRendererHost();
    setRendererHost(rendererHost);
    audioHost = createRecordingAudioHost();
    setAudioHost(audioHost);
    // Services wiring lives in `server/index.js` so the sgnl wiring is
    // optional; the default here is a no-op that's always safe.
    setGameServices({});
}

/** Provide a custom services implementation (SGNL bridge). */
export function useGameServices(impl) {
    setGameServices(impl || {});
}

// ── Map loading ───────────────────────────────────────────────────────

/**
 * Load (or reload) the authoritative world map.
 *
 * `fullReset: true` (default) is the right choice for a fresh server boot
 * or when the marine has just died — the engine resets health/ammo/weapons
 * back to the new-game baseline. `fullReset: false` is what level
 * transitions want: per-level state (keys, projectiles, possession) is
 * cleared, but inventory carries over.
 *
 * @param {string} [name='E1M1']
 * @param {{ fullReset?: boolean }} [options]
 */
export async function loadMap(name = 'E1M1', options = {}) {
    currentMapData = await readMapJson(name);
    await loadMapHeadless(name, async () => currentMapData, options);
    // Clean up any stale recording events that may have been produced by
    // host calls during init (we don't want those replayed as transients).
    rendererHost?.discardEvents?.();
    audioHost?.discardSounds?.();
    return { name: currentMap || name, mapData: currentMapData };
}

export function getMapPayload() {
    return { name: currentMap, mapData: currentMapData };
}

async function readMapJson(name) {
    const file = path.join(MAP_DIR, `${name}.json`);
    const buf = await readFile(file, 'utf8');
    return JSON.parse(buf);
}

// ── Fixed-timestep simulation loop ────────────────────────────────────

/**
 * Start the authoritative game loop. `onTick` fires after every simulated
 * tick so the caller can broadcast snapshots without this module knowing
 * about sockets.
 */
export function startLoop({ onTick } = {}) {
    if (loopTimer) return;
    lastTickTime = Date.now();
    tickNumber = 0;
    loopTimer = setInterval(() => {
        const now = Date.now();
        const dt = Math.min((now - lastTickTime) / 1000, TICK_MS * 4 / 1000);
        lastTickTime = now;

        processConnectionInputs();
        const sessionInputs = collectSessionInputs();
        updateGameMulti(dt, now, sessionInputs);
        syncPlayerControlledIdsFromPossession();
        reconcileDeadControllers();
        tickIdleChecks(now, queueRoleChange);
        tickNumber += 1;

        if (onTick) {
            const shouldSnapshot = (tickNumber % SNAPSHOT_DIVISOR) === 0;
            onTick({ tickNumber, now, shouldSnapshot });
        }
    }, TICK_MS);
}

export function stopLoop() {
    if (!loopTimer) return;
    clearInterval(loopTimer);
    loopTimer = null;
}

/**
 * Drain one-shot flags off each connection's input before we feed it to
 * the engine. `use`, `bodySwap`, and `switchWeapon` are edge-triggered —
 * they should fire once per packet, not every tick.
 */
function processConnectionInputs() {
    for (const conn of listPlayerConnections()) {
        const inp = conn.input;
        if (inp.switchWeapon) {
            if (getControlledFor(conn.sessionId) === player) {
                equipWeapon(inp.switchWeapon);
            }
            inp.switchWeapon = null;
        }
        if (inp.use) {
            const body = getControlledFor(conn.sessionId);
            if (body) {
                tryOpenDoor(body);
                // Vanilla DOOM runs door and switch checks from the same
                // `P_UseLines` traversal; whichever finds a hit wins.
                void tryUseSwitch(body).then(handleSwitchExit);
            }
            inp.use = false;
        }
        if (inp.bodySwap) {
            const target = resolveEntity(inp.bodySwap.targetId);
            if (target && possessFor(conn.sessionId, target)) {
                conn.controlledId = entityId(target);
                pendingRoleChanges.add(conn.sessionId);
            }
            inp.bodySwap = null;
        }
        if (inp.doorDecision) {
            const { sectorIndex, requestId, decision } = inp.doorDecision;
            const doorEntry = state.doorState.get(sectorIndex);
            const doorEntity = doorEntry?.doorEntity || null;
            // Only the operator currently possessing the door may decide.
            if (doorEntity && getControlledFor(conn.sessionId) === doorEntity) {
                resolveDoorRequest(sectorIndex, requestId, decision);
            }
            inp.doorDecision = null;
        }
        if (inp.fireHeld) {
            fireWeaponFor(conn.sessionId);
        }
    }
}

/**
 * Act on a pending exit returned by `tryUseSwitch`. Looks up the next
 * map (or secret exit), reloads the world, and broadcasts the new map
 * payload to every connection so clients can rebuild their scenes.
 */
let exitInFlight = false;
async function handleSwitchExit(action) {
    if (!action) return;
    if (exitInFlight) return;
    if (action.kind !== 'exit' && action.kind !== 'secretExit') return;
    const nextMap = action.kind === 'secretExit' ? getSecretExitMap() : getNextMap();
    if (!nextMap) return;
    exitInFlight = true;
    try {
        await runLevelTransition(nextMap, { fullReset: false });
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[server] switch-triggered map load failed', err);
    } finally {
        exitInFlight = false;
    }
}

/**
 * Tear down the current map, load `nextMap`, then re-bind every connected
 * session to a body. The session that owned the marine pre-transition keeps
 * the marine; the rest re-roll a body via the join policy (random free
 * enemy or spectator).
 *
 * Without this re-binding step, the underlying `loadMap` clears the
 * possession map, which leaves every connection holding a stale entity id
 * — the next snapshot demotes them to spectator and the session is locked
 * out until they reload the page.
 */
async function runLevelTransition(nextMap, loadOptions) {
    // Capture which session held the marine before we wipe possession.
    let prevMarineSessionId = null;
    for (const conn of listPlayerConnections()) {
        if (getControlledFor(conn.sessionId) === player) {
            prevMarineSessionId = conn.sessionId;
            break;
        }
    }

    const { name: mapName, mapData } = await loadMap(nextMap, loadOptions);

    // Re-assign sessions. The previous marine controller goes first so it
    // claims the marine again; everyone else re-rolls a free enemy or
    // becomes a spectator under the standard join policy.
    const all = [...listConnections()];
    const marineFirst = prevMarineSessionId
        ? all.filter((c) => c.sessionId === prevMarineSessionId)
        : [];
    const others = all.filter((c) => c.sessionId !== prevMarineSessionId);
    for (const conn of [...marineFirst, ...others]) {
        const assignment = assignOnJoin(conn);
        conn.role = assignment.role;
        conn.controlledId = assignment.controlledId;
        conn.followTargetId = assignment.followTargetId;
        pendingRoleChanges.add(conn.sessionId);
    }

    for (const conn of listConnections()) {
        // Mark the conn as still loading the new map. The broadcast loop
        // will skip it (no baseline drift) until the client acks with
        // `mapLoadComplete`, at which point its baseline is wiped and
        // the next tick lands as a clean full-state delta.
        conn.pendingMapLoad = true;
        send(conn, { type: MSG.MAP_LOAD, mapName, mapData });
    }
}

/**
 * Public hook used by the menu UI: a client requested a specific map.
 * Inventory carries over (same policy as an exit-switch transition) so
 * dropping into a later level still feels like the same playthrough.
 */
export async function requestMapLoad(name) {
    if (typeof name !== 'string' || !name) return;
    if (exitInFlight) return;
    exitInFlight = true;
    try {
        await runLevelTransition(name, { fullReset: false });
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[server] menu-triggered map load failed', err);
    } finally {
        exitInFlight = false;
    }
}

function collectSessionInputs() {
    /** @type {Map<string, object>} */
    const out = new Map();
    for (const conn of listPlayerConnections()) {
        out.set(conn.sessionId, conn.input);
    }
    return out;
}

/**
 * `conn.controlledId` is only updated on explicit body-swap requests, but
 * `onPossessedDeath()` (engine) can rebind sessions when a possessed body
 * dies. Keep the wire metadata aligned so clients don't stay bound to a
 * dead `thing:` id (which freezes the camera until the next manual swap).
 */
function syncPlayerControlledIdsFromPossession() {
    for (const conn of listPlayerConnections()) {
        if (conn.role !== ROLE.PLAYER) continue;
        const body = getControlledFor(conn.sessionId);
        const id = entityId(body);
        if (id !== conn.controlledId) {
            conn.controlledId = id;
            pendingRoleChanges.add(conn.sessionId);
        }
    }
}

/**
 * After a tick, any session whose body died (inside the engine) needs to
 * be demoted to spectator; and any spectator whose follow target no
 * longer exists needs a fresh target.
 */
function reconcileDeadControllers() {
    for (const conn of listConnections()) {
        if (conn.role === 'player') {
            if (!controlledBodyIsAlive(conn)) {
                const next = demoteToSpectator(conn);
                conn.role = next.role;
                conn.controlledId = next.controlledId;
                conn.followTargetId = next.followTargetId;
                pendingRoleChanges.add(conn.sessionId);
            }
            continue;
        }
        // spectator — re-point if target vanished
        if (!conn.followTargetId || !resolveEntity(conn.followTargetId)) {
            conn.followTargetId = pickNewFollowTargetId(conn.sessionId);
            pendingRoleChanges.add(conn.sessionId);
        }
    }
}

/** Session ids whose role metadata changed since the last drain. */
const pendingRoleChanges = new Set();

export function drainPendingRoleChanges() {
    if (pendingRoleChanges.size === 0) return [];
    const out = [...pendingRoleChanges];
    pendingRoleChanges.clear();
    return out;
}

/**
 * Re-enqueue a role-change announcement that the broadcast loop wasn't
 * able to deliver this tick (e.g. the connection is still finishing a
 * mapLoad). Idempotent — the underlying set dedupes.
 */
export function queueRoleChange(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    pendingRoleChanges.add(sessionId);
}

// ── Snapshot deltas ───────────────────────────────────────────────────
//
// Each connection carries a `baseline` of the last values sent downstream.
// A tick computes the current world once, then for every connection diffs
// the current state against that conn's baseline, emits only the changes,
// and commits those changes back into the baseline. A fresh baseline is
// empty, so the first tick a client receives is effectively a full world
// snapshot.
//
// Baseline lifecycle around map loads is gated by an explicit ack:
//
//   1. Server sends `mapLoad` to a conn and sets `conn.pendingMapLoad = true`.
//   2. Broadcast loop skips conns with `pendingMapLoad`, so no snapshots
//      are sent (and no baseline drift occurs) while the client rebuilds.
//   3. Client finishes its rebuild and replies with `mapLoadComplete`.
//   4. Server clears `pendingMapLoad` and calls `resetBaseline(conn)` so
//      the very next tick carries a clean full-state delta.
//
// Without that ack the server would commit baseline updates for snapshots
// the client dropped during its rebuild window, which then hides spawn-time
// values (e.g. player.z / floorHeight) from every subsequent diff.

/** Allocate a fresh, empty baseline for a newly-attached connection. */
export function emptyBaseline() {
    return {
        player: null,
        things: new Map(),
        projectiles: new Map(),
        doors: new Map(),
        lifts: new Map(),
        crushers: new Map(),
        role: null,
        controlledId: null,
        followTargetId: null,
    };
}

/** Clear a baseline in place. Called when a map load is about to fire. */
export function resetBaseline(conn) {
    if (!conn) return;
    conn.baseline = emptyBaseline();
}

/**
 * Build the delta payload for every connection for the current tick.
 *
 * Drains renderer/audio events once (they're tick-global), serializes the
 * world once into plain objects, and returns a per-conn builder that
 * diffs each conn's baseline against the shared current state and commits
 * the emitted values into the baseline before returning the payload.
 */
export function buildDeltasForTick() {
    const rendererEvents = rendererHost?.drainEvents?.() ?? [];
    const soundEvents   = audioHost?.drainSounds?.()   ?? [];
    const current = serializeCurrentWorld();
    const tick = tickNumber;
    const serverTime = Date.now();

    return (conn) => diffAndCommit(conn, current, {
        tick, serverTime, rendererEvents, soundEvents,
    });
}

// Reusable per-tick "current world" container. The Maps and per-entity
// records are pre-allocated and mutated in place each tick so the
// authoritative loop doesn't churn the GC at 35 Hz × N entities. The
// invariant the diff path relies on:
//
//   - Records are FLAT (no nested mutable objects). Field values are
//     primitives, fresh arrays, or fresh shallow-cloned plain objects so
//     `diffRecord` can compare them against a baseline without aliasing.
//   - `diffIdMap` / `diffKeyedUpdates` MUST clone records when emitting
//     them to the wire (see those functions) — the records survive across
//     ticks and are mutated next tick, so the wire payload cannot share
//     references with `_current.*`.
const _current = {
    player: makeEmptyPlayerRecord(),
    things: new Map(),
    projectiles: new Map(),
    doors: new Map(),
    lifts: new Map(),
    crushers: new Map(),
};

// Per-category live id sets, reused across ticks. Each tick we record
// every id we see, then sweep entries in `_current.*` whose id is missing
// (the entity despawned). `Set#clear()` is O(size) and avoids the per-tick
// allocation of a fresh Set.
const _seenThings = new Set();
const _seenProjectiles = new Set();
const _seenDoors = new Set();
const _seenLifts = new Set();
const _seenCrushers = new Set();

function makeEmptyPlayerRecord() {
    return {
        x: 0, y: 0, z: 0,
        angle: 0,
        floorHeight: 0,
        health: 0,
        armor: 0,
        armorType: null,
        ammo: null,
        maxAmmo: null,
        currentWeapon: null,
        ownedWeapons: null,
        collectedKeys: null,
        powerups: null,
        hasBackpack: false,
        isDead: false,
        isAiDead: false,
        isFiring: false,
        __sessionId: null,
    };
}

function makeEmptyThingRecord() {
    return {
        id: -1,
        type: 0,
        x: 0, y: 0, z: null,
        floorHeight: 0,
        facing: 0,
        viewAngle: null,
        hp: null,
        maxHp: null,
        collected: false,
        aiState: null,
        __sessionId: null,
    };
}

function makeEmptyProjectileRecord() {
    return { id: null, x: 0, y: 0, z: 0 };
}

// Static per-map records below intentionally exclude fields whose values
// never change across the lifetime of a map. Those immutable fields
// (lift.tag/lowerHeight/upperHeight/oneWay, crusher.topHeight/crushHeight,
// door.keyRequired) live in `mapData` and are populated locally on the
// client by `initDoors/initLifts/initCrushers` after each `mapLoad`.
// Shipping them every snapshot would cost bandwidth on every first-sight
// emit and (worse) re-emit them whenever a baseline got reset.

function makeEmptyDoorRecord() {
    return {
        sectorIndex: -1,
        open: false,
        passable: false,
        operatorSessionId: null,
        viewAngle: 0,
        pendingRequests: null,
    };
}

function makeEmptyLiftRecord() {
    return {
        sectorIndex: -1,
        currentHeight: 0,
        targetHeight: 0,
        moving: false,
    };
}

function makeEmptyCrusherRecord() {
    return {
        sectorIndex: -1,
        active: false,
        direction: 0,
        currentHeight: 0,
        damageTimer: 0,
    };
}

/**
 * Snapshot the current world into the reusable `_current` container.
 * Records are mutated in place keyed by their stable wire id; entries for
 * entities that disappeared this tick are evicted by the `_seen*` sweep.
 *
 * The same `_current` reference is passed to every `diffAndCommit` for
 * this tick — diffs read it but don't mutate it, and emit cloned records
 * onto the wire so subsequent ticks can safely overwrite our state.
 */
function serializeCurrentWorld() {
    fillPlayerRecord(_current.player);

    syncThings(_current.things, _seenThings);
    syncProjectiles(_current.projectiles, _seenProjectiles);
    syncDoors(_current.doors, _seenDoors);
    syncLifts(_current.lifts, _seenLifts);
    syncCrushers(_current.crushers, _seenCrushers);

    return _current;
}

function syncThings(map, seen) {
    seen.clear();
    for (let i = 0; i < state.things.length; i++) {
        const t = state.things[i];
        const id = getThingIndex(t);
        let rec = map.get(id);
        if (!rec) {
            rec = makeEmptyThingRecord();
            map.set(id, rec);
        }
        fillThingRecord(rec, id, t);
        seen.add(id);
    }
    sweepStale(map, seen);
}

function syncProjectiles(map, seen) {
    seen.clear();
    for (let i = 0; i < state.projectiles.length; i++) {
        const p = state.projectiles[i];
        let rec = map.get(p.id);
        if (!rec) {
            rec = makeEmptyProjectileRecord();
            map.set(p.id, rec);
        }
        fillProjectileRecord(rec, p);
        seen.add(p.id);
    }
    sweepStale(map, seen);
}

function syncDoors(map, seen) {
    seen.clear();
    for (const entry of state.doorState.values()) {
        const key = entry.sectorIndex;
        let rec = map.get(key);
        if (!rec) {
            rec = makeEmptyDoorRecord();
            map.set(key, rec);
        }
        fillDoorRecord(rec, entry);
        seen.add(key);
    }
    sweepStale(map, seen);
}

function syncLifts(map, seen) {
    seen.clear();
    for (const entry of state.liftState.values()) {
        const key = entry.sectorIndex;
        let rec = map.get(key);
        if (!rec) {
            rec = makeEmptyLiftRecord();
            map.set(key, rec);
        }
        fillLiftRecord(rec, entry);
        seen.add(key);
    }
    sweepStale(map, seen);
}

function syncCrushers(map, seen) {
    seen.clear();
    for (const entry of state.crusherState.values()) {
        const key = entry.sectorIndex;
        let rec = map.get(key);
        if (!rec) {
            rec = makeEmptyCrusherRecord();
            map.set(key, rec);
        }
        fillCrusherRecord(rec, entry);
        seen.add(key);
    }
    sweepStale(map, seen);
}

function sweepStale(map, seen) {
    if (map.size === seen.size) return;
    for (const key of map.keys()) {
        if (!seen.has(key)) map.delete(key);
    }
}

function fillPlayerRecord(rec) {
    rec.x = player.x;
    rec.y = player.y;
    rec.z = player.z;
    rec.angle = player.angle;
    rec.floorHeight = player.floorHeight;
    rec.health = player.health;
    rec.armor = player.armor;
    rec.armorType = player.armorType;
    // Nested objects/arrays: allocate fresh each tick. The diff path
    // assigns these by reference into per-conn baselines, so reusing the
    // same instance would alias the baseline to `_current.player.*` and
    // hide future mutations from the next tick's diff.
    rec.ammo = { ...player.ammo };
    rec.maxAmmo = { ...player.maxAmmo };
    rec.currentWeapon = player.currentWeapon;
    rec.ownedWeapons = [...player.ownedWeapons];
    rec.collectedKeys = [...player.collectedKeys];
    rec.powerups = { ...player.powerups };
    rec.hasBackpack = Boolean(player.hasBackpack);
    rec.isDead = Boolean(player.isDead);
    rec.isAiDead = Boolean(player.isAiDead);
    rec.isFiring = Boolean(player.isFiring);
    rec.__sessionId = player.__sessionId ?? null;
}

function fillThingRecord(rec, id, t) {
    rec.id = id;
    rec.type = t.type;
    rec.x = t.x;
    rec.y = t.y;
    rec.z = t.z ?? null;
    rec.floorHeight = t.floorHeight ?? 0;
    rec.facing = t.facing ?? 0;
    rec.viewAngle = typeof t.viewAngle === 'number' ? t.viewAngle : null;
    rec.hp = t.hp ?? null;
    rec.maxHp = t.maxHp ?? null;
    rec.collected = Boolean(t.collected);
    rec.aiState = t.ai?.state ?? null;
    rec.__sessionId = t.__sessionId ?? null;
}

function fillProjectileRecord(rec, p) {
    rec.id = p.id;
    rec.x = p.x;
    rec.y = p.y;
    rec.z = p.z;
}

function fillDoorRecord(rec, entry) {
    const doorEntity = entry.doorEntity;
    rec.sectorIndex = entry.sectorIndex;
    rec.open = Boolean(entry.open);
    rec.passable = Boolean(entry.passable);
    rec.operatorSessionId = doorEntity?.__sessionId || null;
    rec.viewAngle = typeof doorEntity?.viewAngle === 'number' ? doorEntity.viewAngle : 0;
    // Pending requests churn (id, approachSide, etc.) so a fresh array
    // each tick keeps the diff comparator honest. `fieldsEqual` deep-
    // compares arrays so this still no-ops when contents are unchanged.
    const pending = doorEntity?.pendingRequests;
    if (pending && pending.length > 0) {
        const out = new Array(pending.length);
        for (let i = 0; i < pending.length; i++) {
            const r = pending[i];
            out[i] = {
                id: r.id,
                interactorId: r.interactorId,
                interactorLabel: r.interactorLabel,
                interactorDetails: r.interactorDetails,
                approachSide: r.approachSide,
            };
        }
        rec.pendingRequests = out;
    } else {
        rec.pendingRequests = EMPTY_PENDING_REQUESTS;
    }
}

// Shared empty-array sentinel for doors with no pending requests. Safe to
// share because we never mutate it; the diff path only reads from it and
// any baseline copy is a fresh `{ ...rec }`.
const EMPTY_PENDING_REQUESTS = Object.freeze([]);

function fillLiftRecord(rec, entry) {
    rec.sectorIndex = entry.sectorIndex;
    rec.currentHeight = entry.currentHeight;
    rec.targetHeight = entry.targetHeight;
    rec.moving = Boolean(entry.moving);
}

function fillCrusherRecord(rec, entry) {
    rec.sectorIndex = entry.sectorIndex;
    rec.active = Boolean(entry.active);
    rec.direction = entry.direction;
    rec.currentHeight = entry.currentHeight;
    rec.damageTimer = entry.damageTimer;
}

// ── Diff helpers ──────────────────────────────────────────────────────

/**
 * Compare two values for "did this need to be re-sent" purposes. Primitives
 * are strict-equal; arrays are length+element equal; plain objects are
 * shallow key-by-key equal. Good enough for the serialized shapes above —
 * we don't nest deeper than one level anywhere in the wire records.
 */
function fieldsEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b)) return false;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!fieldsEqual(a[i], b[i])) return false;
        }
        return true;
    }
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
        if (!fieldsEqual(a[k], b[k])) return false;
    }
    return true;
}

/**
 * Return a partial object containing only the keys of `next` whose value
 * differs from `prev`, or `null` if nothing changed. `prev` is allowed to
 * be null (first-time emit) in which case every field of `next` is
 * included except `undefined` values.
 */
function diffRecord(prev, next) {
    if (!prev) {
        const out = {};
        for (const k of Object.keys(next)) {
            if (next[k] !== undefined) out[k] = next[k];
        }
        return out;
    }
    let out = null;
    for (const k of Object.keys(next)) {
        if (!fieldsEqual(prev[k], next[k])) {
            if (!out) out = {};
            out[k] = next[k];
        }
    }
    return out;
}

/**
 * Diff one connection's baseline against the shared current world, commit
 * the emitted values back into `conn.baseline`, and return the outbound
 * delta payload.
 */
function diffAndCommit(conn, current, meta) {
    if (!conn.baseline) conn.baseline = emptyBaseline();
    const baseline = conn.baseline;

    const delta = {
        type: 'snapshot',
        tick: meta.tick,
        serverTime: meta.serverTime,
        rendererEvents: meta.rendererEvents,
        soundEvents: meta.soundEvents,
    };

    if (conn.role !== baseline.role) {
        delta.role = conn.role;
        baseline.role = conn.role;
    }
    if (conn.controlledId !== baseline.controlledId) {
        delta.controlledId = conn.controlledId;
        baseline.controlledId = conn.controlledId;
    }
    if (conn.followTargetId !== baseline.followTargetId) {
        delta.followTargetId = conn.followTargetId;
        baseline.followTargetId = conn.followTargetId;
    }

    const playerPartial = diffRecord(baseline.player, current.player);
    if (playerPartial && Object.keys(playerPartial).length > 0) {
        delta.player = playerPartial;
        // Commit only the emitted fields back into the baseline — fields
        // that didn't change stay at their previous remembered value.
        if (!baseline.player) baseline.player = {};
        for (const k of Object.keys(playerPartial)) {
            baseline.player[k] = playerPartial[k];
        }
    }

    delta.things = diffIdMap(baseline.things, current.things);
    delta.projectiles = diffIdMap(baseline.projectiles, current.projectiles);
    delta.doors = diffKeyedUpdates(baseline.doors, current.doors, 'sectorIndex');
    delta.lifts = diffKeyedUpdates(baseline.lifts, current.lifts, 'sectorIndex');
    delta.crushers = diffKeyedUpdates(baseline.crushers, current.crushers, 'sectorIndex');

    return delta;
}

/**
 * Walk `baseline` vs `current` id->record maps, producing
 * `{ spawn, update, despawn }`. Commits baseline updates in place:
 *   - new ids: emit a fresh clone to `spawn` and stash a separate clone
 *     in `baseline` (the live `record` is reused next tick, so neither
 *     the wire nor the baseline can hold its reference)
 *   - known ids with changed fields: push changed subset to `update`,
 *     merge changes into baseline
 *   - ids in baseline but not current: remove from baseline, push to
 *     `despawn`
 */
function diffIdMap(baselineMap, currentMap) {
    const spawn = [];
    const update = [];
    const despawn = [];

    for (const [id, record] of currentMap) {
        const prev = baselineMap.get(id);
        if (!prev) {
            spawn.push({ ...record });
            baselineMap.set(id, { ...record });
            continue;
        }
        const changed = diffRecord(prev, record);
        if (changed && Object.keys(changed).length > 0) {
            update.push({ id, ...changed });
            for (const k of Object.keys(changed)) prev[k] = changed[k];
        }
    }

    for (const id of baselineMap.keys()) {
        if (!currentMap.has(id)) {
            despawn.push(id);
        }
    }
    for (const id of despawn) baselineMap.delete(id);

    return { spawn, update, despawn };
}

/**
 * Per-sectorIndex static entities (doors/lifts/crushers): membership is
 * fixed across a map, so we only emit `update` entries — any diffs carry
 * the `sectorIndex` plus the changed fields. As with `diffIdMap`, the
 * first emit for a key clones the live record so the reused per-tick
 * record can be safely mutated next tick.
 */
function diffKeyedUpdates(baselineMap, currentMap, keyField) {
    const out = [];
    for (const [key, record] of currentMap) {
        const prev = baselineMap.get(key);
        if (!prev) {
            out.push({ ...record });
            baselineMap.set(key, { ...record });
            continue;
        }
        const changed = diffRecord(prev, record);
        if (changed && Object.keys(changed).length > 0) {
            out.push({ [keyField]: key, ...changed });
            for (const k of Object.keys(changed)) prev[k] = changed[k];
        }
    }
    return out;
}

// ── Role-change announcements ─────────────────────────────────────────

export function buildRoleChangePayload(conn) {
    return {
        type: 'roleChange',
        role: conn.role,
        controlledId: conn.controlledId,
        followTargetId: conn.followTargetId,
    };
}

// ── Utility ───────────────────────────────────────────────────────────

export function getTickRateHz() { return TICK_RATE_HZ; }
export function getCurrentTick() { return tickNumber; }
