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

import { emptyInput } from './net.js';
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
} from './assignment.js';
import { equipWeapon } from '../src/game/combat/weapons.js';
import { fireWeaponFor } from '../src/game/combat/weapons.js';
import { tryOpenDoor, resolveDoorRequest } from '../src/game/mechanics/doors.js';
import { tryUseSwitch } from '../src/game/mechanics/switches.js';
import { getNextMap, getSecretExitMap } from '../src/game/lifecycle.js';
import { possessFor } from '../src/game/possession.js';
import { MSG } from './net.js';
import { send } from './connections.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAP_DIR = path.resolve(__dirname, '..', 'public', 'maps');

const TICK_RATE_HZ = 35; // DOOM's native tic rate
const TICK_MS = 1000 / TICK_RATE_HZ;
const SNAPSHOT_DIVISOR = 2; // send snapshots at ~17 Hz

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

export async function loadMap(name = 'E1M1') {
    currentMapData = await readMapJson(name);
    await loadMapHeadless(name, async () => currentMapData);
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
        reconcileDeadControllers();
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
        const { name: mapName, mapData } = await loadMap(nextMap);
        for (const conn of listConnections()) {
            send(conn, { type: MSG.MAP_LOAD, mapName, mapData });
        }
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[server] switch-triggered map load failed', err);
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

// ── Snapshot ──────────────────────────────────────────────────────────

export function buildSnapshot(conn) {
    const rendererEvents = rendererHost?.drainEvents?.() ?? [];
    const soundEvents   = audioHost?.drainSounds?.()   ?? [];

    return {
        type: 'snapshot',
        tick: tickNumber,
        serverTime: Date.now(),
        role: conn.role,
        controlledId: conn.controlledId,
        followTargetId: conn.followTargetId,
        player: snapshotPlayer(),
        things: snapshotThings(),
        projectiles: snapshotProjectiles(),
        doors: [...state.doorState.values()].map(serializeDoor),
        lifts: [...state.liftState.values()].map(serializeLift),
        crushers: [...state.crusherState.values()].map(serializeCrusher),
        rendererEvents,
        soundEvents,
    };
}

/**
 * Build a single snapshot that fans out to every connection. Renderer /
 * audio events are only drained once per tick, so this helper drains them
 * once and clones the rest of the payload per-connection (role, controlled
 * id, follow target differ per viewer).
 */
export function buildSnapshotBatch() {
    const rendererEvents = rendererHost?.drainEvents?.() ?? [];
    const soundEvents   = audioHost?.drainSounds?.()   ?? [];

    const shared = {
        type: 'snapshot',
        tick: tickNumber,
        serverTime: Date.now(),
        player: snapshotPlayer(),
        things: snapshotThings(),
        projectiles: snapshotProjectiles(),
        doors: [...state.doorState.values()].map(serializeDoor),
        lifts: [...state.liftState.values()].map(serializeLift),
        crushers: [...state.crusherState.values()].map(serializeCrusher),
        rendererEvents,
        soundEvents,
    };

    return (conn) => ({
        ...shared,
        role: conn.role,
        controlledId: conn.controlledId,
        followTargetId: conn.followTargetId,
    });
}

function snapshotPlayer() {
    return {
        x: player.x, y: player.y, z: player.z,
        angle: player.angle,
        floorHeight: player.floorHeight,
        health: player.health,
        armor: player.armor,
        armorType: player.armorType,
        ammo: { ...player.ammo },
        maxAmmo: { ...player.maxAmmo },
        currentWeapon: player.currentWeapon,
        ownedWeapons: [...player.ownedWeapons],
        collectedKeys: [...player.collectedKeys],
        powerups: { ...player.powerups },
        hasBackpack: player.hasBackpack,
        isDead: player.isDead,
        isAiDead: player.isAiDead,
        isFiring: player.isFiring,
        __sessionId: player.__sessionId ?? null,
    };
}

function snapshotThings() {
    const out = new Array(state.things.length);
    for (let i = 0; i < state.things.length; i++) {
        const t = state.things[i];
        out[i] = {
            id: getThingIndex(t),
            type: t.type,
            x: t.x, y: t.y, z: t.z ?? null,
            floorHeight: t.floorHeight ?? 0,
            facing: t.facing ?? 0,
            viewAngle: typeof t.viewAngle === 'number' ? t.viewAngle : null,
            hp: t.hp ?? null,
            maxHp: t.maxHp ?? null,
            collected: Boolean(t.collected),
            aiState: t.ai?.state ?? null,
            __sessionId: t.__sessionId ?? null,
        };
    }
    return out;
}

function snapshotProjectiles() {
    const out = new Array(state.projectiles.length);
    for (let i = 0; i < state.projectiles.length; i++) {
        const p = state.projectiles[i];
        out[i] = {
            id: p.id,
            x: p.x, y: p.y, z: p.z,
        };
    }
    return out;
}

function serializeDoor(entry) {
    const doorEntity = entry.doorEntity;
    const operatorSessionId = doorEntity?.__sessionId || null;
    const pendingRequests = (doorEntity?.pendingRequests || []).map((r) => ({
        id: r.id,
        interactorId: r.interactorId,
        interactorLabel: r.interactorLabel,
        interactorDetails: r.interactorDetails,
        approachSide: r.approachSide,
    }));
    return {
        sectorIndex: entry.sectorIndex,
        open: Boolean(entry.open),
        passable: Boolean(entry.passable),
        keyRequired: entry.keyRequired || null,
        operatorSessionId,
        viewAngle: typeof doorEntity?.viewAngle === 'number' ? doorEntity.viewAngle : 0,
        pendingRequests,
    };
}

function serializeLift(entry) {
    return {
        sectorIndex: entry.sectorIndex,
        tag: entry.tag ?? null,
        currentHeight: entry.currentHeight,
        targetHeight: entry.targetHeight,
        lowerHeight: entry.lowerHeight,
        upperHeight: entry.upperHeight,
        moving: Boolean(entry.moving),
        oneWay: Boolean(entry.oneWay),
    };
}

function serializeCrusher(entry) {
    return {
        sectorIndex: entry.sectorIndex,
        active: Boolean(entry.active),
        direction: entry.direction,
        currentHeight: entry.currentHeight,
        topHeight: entry.topHeight,
        crushHeight: entry.crushHeight,
        damageTimer: entry.damageTimer,
    };
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
