import { getMarineActor } from '../../src/game/state.js';
import { getControlledFor } from '../../src/game/possession.js';
import {
    controlledBodyIsAlive,
    demoteToSpectator,
    entityId,
    pickNewFollowTargetId,
    resolveEntity,
} from '../assignment.js';
import {
    listConnections,
    listPlayerConnections,
} from '../connections.js';
import { ROLE } from '../net.js';

const pendingRoleChanges = new Set();

export function syncPlayerControlledIdsFromPossession() {
    for (const conn of listPlayerConnections()) {
        if (conn.role !== ROLE.PLAYER) continue;
        const body = getControlledFor(conn.sessionId);
        const id = entityId(body);
        if (id !== conn.controlledId) {
            conn.controlledId = id;
            queueRoleChange(conn.sessionId);
        }
    }
}

export function reconcileDeadControllers() {
    for (const conn of listConnections()) {
        if (conn.role === ROLE.PLAYER) {
            if (!controlledBodyIsAlive(conn)) {
                const next = demoteToSpectator(conn);
                conn.role = next.role;
                conn.controlledId = next.controlledId;
                conn.followTargetId = next.followTargetId;
                queueRoleChange(conn.sessionId);
            }
            continue;
        }
        if (!conn.followTargetId || !resolveEntity(conn.followTargetId)) {
            conn.followTargetId = pickNewFollowTargetId(conn.sessionId);
            queueRoleChange(conn.sessionId);
        }
    }
}

export function queueRoleChange(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    pendingRoleChanges.add(sessionId);
}

export function drainPendingRoleChanges() {
    if (pendingRoleChanges.size === 0) return [];
    const out = [...pendingRoleChanges];
    pendingRoleChanges.clear();
    return out;
}

export function buildRoleChangePayload(conn) {
    return {
        type: 'roleChange',
        role: conn.role,
        controlledId: conn.controlledId,
        followTargetId: conn.followTargetId,
    };
}

export function findMarineControllerSessionId() {
    for (const conn of listPlayerConnections()) {
        if (getControlledFor(conn.sessionId) === getMarineActor()) {
            return conn.sessionId;
        }
    }
    return null;
}

