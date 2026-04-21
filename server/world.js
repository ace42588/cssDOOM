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

import { getMarine, state } from '../src/game/state.js';
import { updateGameMulti } from '../src/game/index.js';
import { getControlledFor } from '../src/game/possession.js';

import { listPlayerConnections } from './connections.js';
import {
    entityId,
    resolveEntity,
} from './assignment.js';
import { equipWeapon } from '../src/game/combat/weapons.js';
import { fireWeaponFor } from '../src/game/combat/weapons.js';
import { tryOpenDoor, resolveDoorRequest } from '../src/game/mechanics/doors.js';
import { tryUseSwitch } from '../src/game/mechanics/switches.js';
import { possessFor } from '../src/game/possession.js';
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

export { emptyBaseline, resetBaseline } from './world/snapshots.js';
export { getMapPayload, loadMap, requestMapLoad } from './world/maps.js';
export {
    buildRoleChangePayload,
    drainPendingRoleChanges,
    queueRoleChange,
} from './world/roles.js';

const TICK_RATE_HZ = 70; // DOOM's native tic rate
const TICK_MS = 1000 / TICK_RATE_HZ;
const SNAPSHOT_DIVISOR = 2; // send snapshots at 35 Hz

let rendererHost = null;
let audioHost = null;
let tickNumber = 0;
let loopTimer = null;
let lastTickTime = 0;

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
            if (getControlledFor(conn.sessionId) === getMarine()) {
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
