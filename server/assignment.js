/**
 * Strict auto-assignment policy.
 *
 * Connection rules:
 *   - The first joining session gets the marine.
 *   - Subsequent sessions possess the lowest-index living, unpossessed enemy.
 *   - If nothing playable is available, the session becomes a spectator
 *     following a randomly-picked currently-controlled body.
 *
 * Death / disconnect rules:
 *   - A dying (or disconnected) body reverts to AI control.
 *   - The session that lost its body does NOT get a new one. It is
 *     demoted to spectator and starts following another player.
 *   - Spectators never get promoted back to active play; they watch
 *     until they reconnect (which is a fresh session anyway).
 *
 * All functions here are pure with respect to `state.things` / the marine (`getMarineActor()`)
 * and the possession module — the server's world loop calls them at
 * explicit lifecycle points (connect / disconnect / body death / tick).
 */

import { getMarineActor, state } from '../src/game/state.js';
import {
    ENEMIES,
} from '../src/game/constants.js';
import {
    possessFor,
    releaseFor,
    isHumanControlled,
    getControlledFor,
    listHumanControlledEntries,
} from '../src/game/possession.js';
import { getThingIndex, getActorIndex } from '../src/game/things/registry.js';
import { getConnection } from './connections.js';
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

function pickRandom(list) {
    if (list.length === 0) return null;
    return list[Math.floor(Math.random() * list.length)];
}

/** Deterministic pick: lowest thing index among free enemies (stable across reconnects). */
function slotIndex(entity) {
    const a = getActorIndex(entity);
    if (a >= 0) return a;
    return getThingIndex(entity);
}

function pickLowestIndexEnemy(enemies) {
    if (enemies.length === 0) return null;
    let best = enemies[0];
    let bestIdx = slotIndex(best);
    for (let i = 1; i < enemies.length; i++) {
        const t = enemies[i];
        const idx = slotIndex(t);
        if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) {
            best = t;
            bestIdx = idx;
        }
    }
    return best;
}

function pickFollowTarget(excludeSessionId) {
    const entries = listHumanControlledEntries().filter(([sid]) => sid !== excludeSessionId);
    if (entries.length === 0) return null;
    const [, entity] = entries[Math.floor(Math.random() * entries.length)];
    return entityId(entity);
}

/**
 * Pick an MCP-controlled body that a joining spectator could challenge for
 * displacement. Prefer the marine if held by an MCP session; else the
 * lowest-index living enemy held by MCP.
 *
 * @returns {{ sessionId: string, entity: import('../src/game/state.js').Player|import('../src/game/state.js').Thing, kind: 'marine'|'enemy' }|null}
 */
function findDisplaceableTarget() {
    const entries = listHumanControlledEntries();
    const mcpEntries = entries.filter(([sid]) => {
        const c = getConnection(sid);
        return Boolean(c && c.kind === 'mcp');
    });
    if (mcpEntries.length === 0) return null;

    const marine = getMarineActor();
    if (marine) {
        const marineEntry = mcpEntries.find(([, ent]) => ent === marine);
        if (marineEntry && marine.hp > 0 && !marine.deathMode) {
            return { sessionId: marineEntry[0], entity: marine, kind: 'marine' };
        }
    }

    let best = null;
    let bestIdx = Infinity;
    for (const [sid, ent] of mcpEntries) {
        if (ent === marine) continue;
        if (!isLivingEnemy(ent)) continue;
        const idx = slotIndex(ent);
        if (idx >= 0 && idx < bestIdx) {
            bestIdx = idx;
            best = { sessionId: sid, entity: ent, kind: 'enemy' };
        }
    }
    return best;
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
 * Mutates the possession map via `possessFor` when a body is claimed.
 *
 * @param {object} [options]
 * @param {string|null} [options.preferredControlledId] — e.g. `'player'` or `'thing:12'`; honored first when still possessable (MCP sticky reconnect).
 */
export function assignOnJoin(conn, options = {}) {
    // Killer-promotion takes priority over everything else: if this session
    // killed the previous marine and we're now back at assignment time
    // (post-restart), hand them the marine if it's live and free. Otherwise
    // we drop the pending flag and fall through to the regular policy.
    if (pendingMarinePromotionSessionId
        && pendingMarinePromotionSessionId === conn.sessionId) {
        pendingMarinePromotionSessionId = null;
        const m = getMarineActor();
        if (m && !isHumanControlled(m) && m.hp > 0 && !m.deathMode) {
            if (possessFor(conn.sessionId, m)) {
                return {
                    role: ROLE.PLAYER,
                    controlledId: entityId(m),
                    followTargetId: null,
                };
            }
        }
    }

    const pref = options.preferredControlledId;
    if (pref) {
        const entity = resolveEntity(pref);
        const m = getMarineActor();
        if (entity && entity === m) {
            if (!isHumanControlled(m) && m.hp > 0 && !m.deathMode) {
                if (possessFor(conn.sessionId, m)) {
                    return {
                        role: ROLE.PLAYER,
                        controlledId: entityId(m),
                        followTargetId: null,
                    };
                }
            }
        } else if (entity && !entity.__isDoorEntity) {
            if (isLivingEnemy(entity) && !isHumanControlled(entity)) {
                if (possessFor(conn.sessionId, entity)) {
                    return {
                        role: ROLE.PLAYER,
                        controlledId: entityId(entity),
                        followTargetId: null,
                    };
                }
            }
        }
    }

    // Marine first (if one exists and isn't already held).
    const marine = getMarineActor();
    if (marine && !isHumanControlled(marine) && marine.hp > 0 && !marine.deathMode) {
        if (possessFor(conn.sessionId, marine)) {
            return {
                role: ROLE.PLAYER,
                controlledId: entityId(marine),
                followTargetId: null,
            };
        }
    }

    // Then lowest-index free enemy (deterministic). Skip the marine explicitly
    // rather than relying on a fixed slot: actors list is now a peer list.
    const freeEnemies = state.actors.filter(
        (t) => t && t !== marine && isLivingEnemy(t) && !isHumanControlled(t),
    );
    const enemy = pickLowestIndexEnemy(freeEnemies);
    if (enemy) {
        if (possessFor(conn.sessionId, enemy)) {
            return {
                role: ROLE.PLAYER,
                controlledId: entityId(enemy),
                followTargetId: null,
            };
        }
    }

    // No playable body available — spectator (may still challenge an MCP-held body).
    const displaceCandidate = findDisplaceableTarget();
    return {
        role: ROLE.SPECTATOR,
        controlledId: null,
        followTargetId: pickFollowTarget(conn.sessionId),
        ...(displaceCandidate ? { displaceCandidate } : {}),
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
        followTargetId: pickFollowTarget(conn.sessionId),
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
    return pickFollowTarget(sessionId);
}

/**
 * True if `sessionId`'s currently-controlled body is still alive. The
 * server calls this each tick to detect deaths that happened inside the
 * engine and demote players promptly.
 */
export function controlledBodyIsAlive(conn) {
    return isActorAlive(getControlledFor(conn.sessionId));
}
