/**
 * Session assignment and spectator follow helpers.
 *
 * Every joining session starts as spectator. Possession is explicit and
 * handled via spectator actions after the session is established.
 */

import { getMarineActor, state } from '../src/game/state.js';
import {
    ENEMIES,
} from '../src/game/constants.js';
import {
    releaseFor,
    getControlledFor,
} from '../src/game/possession.js';
import { getThingIndex, getActorIndex } from '../src/game/things/registry.js';
import { ROLE } from './net.js';
import { formatRuntimeId, resolveRuntimeId } from '../src/game/entity/id.js';
import { isActorAlive } from '../src/game/entity/caps.js';

export const entityId = formatRuntimeId;
export const resolveEntity = resolveRuntimeId;

// ── Killer → marine promotion ─────────────────────────────────────────
//
// `server/world.js#checkMarineLossRestart` captures the dying marine's
// `lastDamagedBySessionId` just before triggering `resetCurrentMap()`.
// On the next `assignOnJoin(conn)` for that session, the joiner skips the
// normal marine-first / lowest-enemy rules and claims the marine spot
// directly. After a successful claim (or after any call that would
// otherwise reassign the marine) the pending session is cleared so only
// one promotion is granted per death.
let pendingMarinePromotionSessionId = null;

/** Record the session that killed the marine, to be promoted on restart. */
export function setPendingMarinePromotion(sessionId) {
    pendingMarinePromotionSessionId =
        typeof sessionId === 'string' && sessionId ? sessionId : null;
}

/** Read the pending promotion id without consuming it. */
export function getPendingMarinePromotionSessionId() {
    return pendingMarinePromotionSessionId;
}

/** Drop any pending promotion (used on fallback or after the spot lands). */
export function clearPendingMarinePromotion() {
    pendingMarinePromotionSessionId = null;
}

function isLivingEnemy(thing) {
    if (!thing || !thing.ai) return false;
    if (!ENEMIES.has(thing.type)) return false;
    if (thing.collected) return false;
    return (thing.hp ?? 0) > 0;
}

/** Deterministic pick: lowest thing index among free enemies (stable across reconnects). */
function slotIndex(entity) {
    const a = getActorIndex(entity);
    if (a >= 0) return a;
    return getThingIndex(entity);
}

function compareSlotIndexAsc(a, b) {
    return slotIndex(a) - slotIndex(b);
}

export function listPossessableActors() {
    /** @type {Array<import('../src/game/state.js').Player|import('../src/game/state.js').Thing>} */
    const out = [];
    const marine = getMarineActor();
    if (marine && marine.hp > 0 && !marine.deathMode) {
        out.push(marine);
    }
    const enemies = state.actors
        .filter((entity) => entity && entity !== marine && isLivingEnemy(entity))
        .sort(compareSlotIndexAsc);
    for (const enemy of enemies) {
        out.push(enemy);
    }
    return out;
}

export function isPossessableActorEntity(entity) {
    if (!entity || entity.__isDoorEntity) return false;
    const marine = getMarineActor();
    if (entity === marine) return Boolean(marine && marine.hp > 0 && !marine.deathMode);
    return isLivingEnemy(entity);
}

function pickFollowTarget() {
    const actors = listPossessableActors();
    if (actors.length === 0) return null;
    return entityId(actors[0]);
}

/**
 * Demote `targetConn` from its body and give `entity` to `joinerConn`.
 * Updates both connection objects; callers should `queueRoleChange` for each.
 *
 * @returns {{ joiner: import('./connections.js').Connection, target: import('./connections.js').Connection }}
 */
export function applyDisplacement(joinerConn, targetConn, entity) {
    releaseFor(targetConn.sessionId);
    possessFor(joinerConn.sessionId, entity);

    joinerConn.role = ROLE.PLAYER;
    joinerConn.controlledId = entityId(entity);
    joinerConn.followTargetId = null;

    targetConn.role = ROLE.SPECTATOR;
    targetConn.controlledId = null;
    targetConn.followTargetId = pickFollowTarget(targetConn.sessionId);

    return { joiner: joinerConn, target: targetConn };
}

/**
 * Called when a fresh session connects. Returns an assignment:
 *   { role, controlledId, followTargetId }
 *
 * Joining sessions always start as spectators.
 */
export function assignOnJoin(conn, options = {}) {
    void options;
    if (pendingMarinePromotionSessionId === conn.sessionId) {
        pendingMarinePromotionSessionId = null;
    }
    return {
        role: ROLE.SPECTATOR,
        controlledId: null,
        followTargetId: pickFollowTarget(),
    };
}

/**
 * Called when a session's body dies (or after a crash / disconnect). The
 * session loses its body and is demoted to spectator. Returns the new
 * assignment so the server can update the connection + notify the client.
 */
export function demoteToSpectator(conn) {
    releaseFor(conn.sessionId);
    return {
        role: ROLE.SPECTATOR,
        controlledId: null,
        followTargetId: pickFollowTarget(),
    };
}

/**
 * Called when a session disconnects. Just releases the body back to AI —
 * the connection object is discarded by `connections.removeConnection`.
 */
export function releaseOnDisconnect(conn) {
    releaseFor(conn.sessionId);
}

/**
 * Pick a fresh follow target for a spectator whose current target just
 * died or disconnected. Returns a new `followTargetId` (or null if the
 * server is empty of controlled bodies).
 */
export function pickNewFollowTargetId(sessionId) {
    void sessionId;
    return pickFollowTarget();
}

/**
 * True if `sessionId`'s currently-controlled body is still alive. The
 * server calls this each tick to detect deaths that happened inside the
 * engine and demote players promptly.
 */
export function controlledBodyIsAlive(conn) {
    return isActorAlive(getControlledFor(conn.sessionId));
}
