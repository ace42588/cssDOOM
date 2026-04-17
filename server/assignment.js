/**
 * Strict auto-assignment policy.
 *
 * Connection rules:
 *   - The first joining session gets the marine.
 *   - Subsequent sessions possess a random living, unpossessed enemy.
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
 * All functions here are pure with respect to `state.things`/`player`
 * and the possession module — the server's world loop calls them at
 * explicit lifecycle points (connect / disconnect / body death / tick).
 */

import { player, state } from '../src/game/state.js';
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
import { getThingIndex } from '../src/game/things/registry.js';
import { ROLE } from './net.js';

/** Stable id for an entity (marine = 'player', things = 'thing:<idx>'). */
export function entityId(entity) {
    if (!entity) return null;
    if (entity === player) return 'player';
    if (entity.__isDoorEntity) return `door:${entity.sectorIndex}`;
    const idx = getThingIndex(entity);
    return idx >= 0 ? `thing:${idx}` : null;
}

export function resolveEntity(id) {
    if (!id) return null;
    if (id === 'player') return player;
    if (id.startsWith('thing:')) {
        const idx = Number(id.slice('thing:'.length));
        return state.things[idx] || null;
    }
    if (id.startsWith('door:')) {
        const sectorIndex = Number(id.slice('door:'.length));
        const entry = state.doorState.get(sectorIndex);
        return entry?.doorEntity || null;
    }
    return null;
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

function pickFollowTarget(excludeSessionId) {
    const entries = listHumanControlledEntries().filter(([sid]) => sid !== excludeSessionId);
    if (entries.length === 0) return null;
    const [, entity] = entries[Math.floor(Math.random() * entries.length)];
    return entityId(entity);
}

/**
 * Called when a fresh session connects. Returns an assignment:
 *   { role, controlledId, followTargetId }
 *
 * Mutates the possession map via `possessFor` when a body is claimed.
 */
export function assignOnJoin(conn) {
    // Marine first.
    if (!isHumanControlled(player) && !player.isDead && !player.isAiDead) {
        if (possessFor(conn.sessionId, player)) {
            return {
                role: ROLE.PLAYER,
                controlledId: entityId(player),
                followTargetId: null,
            };
        }
    }

    // Then a random free enemy.
    const freeEnemies = state.things.filter(
        (t) => isLivingEnemy(t) && !isHumanControlled(t),
    );
    const enemy = pickRandom(freeEnemies);
    if (enemy) {
        if (possessFor(conn.sessionId, enemy)) {
            return {
                role: ROLE.PLAYER,
                controlledId: entityId(enemy),
                followTargetId: null,
            };
        }
    }

    // No playable body available — spectator.
    return {
        role: ROLE.SPECTATOR,
        controlledId: null,
        followTargetId: pickFollowTarget(conn.sessionId),
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
    const entity = getControlledFor(conn.sessionId);
    if (!entity) return false;
    if (entity === player) return !player.isDead && !player.isAiDead;
    // Doors are always "alive" — they have no hp and can't be killed.
    if (entity.__isDoorEntity) return true;
    if (entity.collected) return false;
    return (entity.hp ?? 0) > 0;
}
