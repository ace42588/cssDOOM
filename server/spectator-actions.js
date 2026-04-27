import { getSessionIdControlling, possessFor } from '../src/engine/possession.js';
import {
    entityId,
    isPossessableActorEntity,
    listPossessableActors,
    resolveEntity,
} from './assignment.js';
import { getConnection, send } from './connections.js';
import { MSG, ROLE } from './net.js';
import { startChallenge } from './join-challenge.js';
import { queueRoleChange } from './world/roles.js';

function orderedPossessableIds() {
    return listPossessableActors().map((entity) => entityId(entity)).filter(Boolean);
}

function rotateFollowTargetId(currentId, direction) {
    const ids = orderedPossessableIds();
    if (ids.length === 0) return null;
    const idx = ids.indexOf(currentId);
    if (idx < 0) return ids[0];
    const delta = direction === 'prev' ? -1 : 1;
    return ids[(idx + delta + ids.length) % ids.length];
}

export function rotateSpectatorFollow(conn, direction) {
    if (!conn || conn.role !== ROLE.SPECTATOR) return false;
    const next = rotateFollowTargetId(conn.followTargetId, direction);
    if (next === conn.followTargetId) return true;
    conn.followTargetId = next;
    queueRoleChange(conn.sessionId);
    return true;
}

export function possessAsSpectator(conn, targetId) {
    if (!conn || conn.role !== ROLE.SPECTATOR) return false;
    const wantedId = typeof targetId === 'string' && targetId ? targetId : conn.followTargetId;
    const target = resolveEntity(wantedId);
    if (!target || !isPossessableActorEntity(target)) {
        send(conn, {
            type: MSG.NOTICE,
            code: 'spectator-possess-invalid',
            message: 'Cannot possess that actor.',
        });
        return false;
    }

    const controllerSessionId = getSessionIdControlling(target);
    if (!controllerSessionId) {
        if (!possessFor(conn.sessionId, target)) {
            send(conn, {
                type: MSG.NOTICE,
                code: 'spectator-possess-failed',
                message: 'Could not possess that actor.',
            });
            return false;
        }
        conn.role = ROLE.PLAYER;
        conn.controlledId = entityId(target);
        conn.followTargetId = null;
        queueRoleChange(conn.sessionId);
        return true;
    }

    const targetConn = getConnection(controllerSessionId);
    if (!targetConn) {
        send(conn, {
            type: MSG.NOTICE,
            code: 'spectator-possess-failed',
            message: 'Could not possess that actor.',
        });
        return false;
    }

    if (targetConn.kind !== 'mcp') {
        send(conn, {
            type: MSG.NOTICE,
            code: 'spectator-possess-busy',
            message: 'That actor is already controlled by another player.',
        });
        return false;
    }

    const started = startChallenge(conn, {
        sessionId: targetConn.sessionId,
        entity: target,
    });
    if (!started) {
        send(conn, {
            type: MSG.NOTICE,
            code: 'spectator-challenge-unavailable',
            message: 'A challenge is already active for that actor.',
        });
        return false;
    }
    return true;
}
