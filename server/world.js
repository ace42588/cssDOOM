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

import { setRendererHost } from '../src/renderer/index.js';
import { createRecordingRendererHost } from '../src/renderer/recording-host.js';
import { setAudioHost } from '../src/audio/audio.js';
import { createRecordingAudioHost } from '../src/audio/recording-host.js';
import { setGameServices } from '../src/game/services.js';

import { getMarineActor, state } from '../src/game/state.js';
import { updateGameMulti } from '../src/game/index.js';
import { getControlledFor } from '../src/game/possession.js';

import { listPlayerConnections } from './connections.js';
import {
    entityId,
    resolveEntity,
    setPendingMarinePromotion,
    clearPendingMarinePromotion,
} from './assignment.js';
import { getConnection } from './connections.js';
import { findMarineControllerSessionId } from './world/roles.js';
import { equipWeapon } from '../src/game/combat/weapons.js';
import { fireWeaponFor } from '../src/game/combat/weapons.js';
import { tryOpenDoor, resolveDoorRequest } from '../src/game/mechanics/doors.js';
import { tryUseSwitch } from '../src/game/mechanics/switches.js';
import { possessFor } from '../src/game/possession.js';
import { canSwitchWeapons } from '../src/game/entity/caps.js';
import { tickIdleChecks } from './idle.js';
import {
    handleSwitchExit,
    setMapLoadEventHosts,
} from './world/maps.js';
import {
    buildRoleChangePayload,
    drainPendingRoleChanges,
    queueRoleChange,
    reconcileDeadControllers,
    syncPlayerControlledIdsFromPossession,
} from './world/roles.js';
import {
    diffAndCommit,
    emptyBaseline,
    resetBaseline,
    serializeCurrentWorld,
} from './world/snapshots.js';
import { resetCurrentMap } from './world/maps.js';

export { emptyBaseline, resetBaseline } from './world/snapshots.js';
export {
    getMapPayload,
    loadMap,
    requestMapLoad,
} from './world/maps.js';
export {
    buildRoleChangePayload,
    drainPendingRoleChanges,
    queueRoleChange,
} from './world/roles.js';

const TICK_RATE_HZ = 70; // DOOM's native tic rate
const TICK_MS = 1000 / TICK_RATE_HZ;
const SNAPSHOT_DIVISOR = 2; // send snapshots at 35 Hz
const MARINE_LOSS_RESTART_MS = 4000;

let rendererHost = null;
let audioHost = null;
let tickNumber = 0;
let loopTimer = null;
let lastTickTime = 0;
// Zero-marine game-over: the server auto-restarts the current map if there
// is no live marine-type actor for longer than `MARINE_LOSS_RESTART_MS`.
// Tracks when the loss first became true (null = there's a live marine).
let marineLossSince = null;
let marineRestartInFlight = false;

// ── Host installation ─────────────────────────────────────────────────

export function installEngineHosts() {
    rendererHost = createRecordingRendererHost();
    setRendererHost(rendererHost);
    audioHost = createRecordingAudioHost();
    setAudioHost(audioHost);
    setMapLoadEventHosts({ rendererHost, audioHost });
    // Services wiring lives in `server/index.js` so the sgnl wiring is
    // optional; the default here is a no-op that's always safe.
    setGameServices({});
}

/** Provide a custom services implementation (SGNL bridge). */
export function useGameServices(impl) {
    setGameServices(impl || {});
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
        checkMarineLossRestart(now);
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
 * Zero-marine game-over: if no live marine-type actor is present for longer
 * than `MARINE_LOSS_RESTART_MS`, trigger a full reset of the current map.
 * Sessions whose controlled actor is also gone have already been demoted by
 * `reconcileDeadControllers`; the map reload wipes the rest of the world and
 * `assignOnJoin` hands the marine to whichever connection joins first again.
 */
function checkMarineLossRestart(now) {
    if (marineRestartInFlight) return;
    const m = getMarineActor();
    const alive = Boolean(m) && m.hp > 0 && m.deathMode !== 'gameover';
    if (alive) {
        marineLossSince = null;
        return;
    }
    if (marineLossSince === null) {
        marineLossSince = now;
        return;
    }
    if (now - marineLossSince < MARINE_LOSS_RESTART_MS) return;

    // Killer → marine promotion: whoever last damaged the dying marine
    // (as long as they're still connected and aren't the marine's own
    // controller — suicide falls back to default policy) gets first dibs
    // on the marine spot after the map reloads.
    capturePendingMarinePromotion(m);

    marineRestartInFlight = true;
    marineLossSince = null;
    Promise.resolve()
        .then(() => resetCurrentMap())
        .catch((err) => {
            // eslint-disable-next-line no-console
            console.error('[server] marine-loss restart failed', err);
        })
        .finally(() => {
            marineRestartInFlight = false;
        });
}

function capturePendingMarinePromotion(marine) {
    clearPendingMarinePromotion();
    if (!marine) return;
    const killerSid = marine.lastDamagedBySessionId;
    if (typeof killerSid !== 'string' || !killerSid) return;
    // Suicide (the marine's own controller killed itself via splash /
    // barrels / sector damage): no promotion — same session would just
    // get the marine back under the normal marine-first rule anyway.
    if (killerSid === findMarineControllerSessionId()) return;
    // Killer has since disconnected: nothing to promote.
    if (!getConnection(killerSid)) return;
    setPendingMarinePromotion(killerSid);
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
            // Only actors with a real weapon loadout (marine-shaped) honor
            // switch-weapon inputs; intrinsic-weapon monsters carry one slot
            // so `canSwitchWeapons` returns false for them.
            const body = getControlledFor(conn.sessionId);
            if (canSwitchWeapons(body)) {
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
                queueRoleChange(conn.sessionId);
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

function collectSessionInputs() {
    /** @type {Map<string, object>} */
    const out = new Map();
    for (const conn of listPlayerConnections()) {
        out.set(conn.sessionId, conn.input);
    }
    return out;
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

// ── Utility ───────────────────────────────────────────────────────────

export function getTickRateHz() { return TICK_RATE_HZ; }
export function getCurrentTick() { return tickNumber; }
