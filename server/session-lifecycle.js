import { addConnection, getConnection, removeConnection, send } from './connections.js';
import { assignOnJoin, releaseOnDisconnect } from './assignment.js';
import {
    emitSessionEstablished,
    registerSession,
    unregisterSession,
} from './sgnl/index.js';
import { getMapPayload, getTickRateHz } from './world.js';
import { MSG } from './net.js';

export function openWebSocketGameSession(ws, options = {}) {
    const conn = addConnection(ws);
    initializeGameSession(conn, options);
    return conn;
}

export function initializeGameSession(conn, {
    displayName,
    assignmentOptions = {},
} = {}) {
    registerSession(conn.sessionId, displayName ? { displayName } : undefined);
    emitSessionEstablished(conn.sessionId);

    const assignment = assignOnJoin(conn, assignmentOptions);
    conn.role = assignment.role;
    conn.controlledId = assignment.controlledId;
    conn.followTargetId = assignment.followTargetId;

    const { name: mapName, mapData } = getMapPayload();
    send(conn, {
        type: MSG.WELCOME,
        sessionId: conn.sessionId,
        role: conn.role,
        controlledId: conn.controlledId,
        followTargetId: conn.followTargetId,
        mapName,
        tickRateHz: getTickRateHz(),
        serverTime: Date.now(),
    });
    send(conn, { type: MSG.MAP_LOAD, mapName, mapData });

    return conn;
}

export function closeGameSession(sessionOrConn) {
    const sessionId = typeof sessionOrConn === 'string'
        ? sessionOrConn
        : sessionOrConn?.sessionId;
    if (!sessionId) return null;

    const conn = getConnection(sessionId);
    if (!conn) return null;

    releaseOnDisconnect(conn);
    removeConnection(sessionId);
    unregisterSession(sessionId);
    return conn;
}

