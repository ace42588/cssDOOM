import { addConnection, getConnection, send, removeConnection } from './connections.js';
import { closeMcpHttpSessionForGameSession } from './mcp/http-transport-by-game.js';
import { assignOnJoin, releaseOnDisconnect } from './assignment.js';
import { cancelChallengesInvolvingSession, startChallenge } from './join-challenge.js';
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

    if (assignment.displaceCandidate) {
        startChallenge(conn, assignment.displaceCandidate);
    }

    return conn;
}

export function closeGameSession(sessionOrConn) {
    const sessionId = typeof sessionOrConn === 'string'
        ? sessionOrConn
        : sessionOrConn?.sessionId;
    if (!sessionId) return null;

    const conn = getConnection(sessionId);
    if (!conn) return null;

    cancelChallengesInvolvingSession(sessionId);
    releaseOnDisconnect(conn);
    removeConnection(sessionId);
    unregisterSession(sessionId);
    return conn;
}

/**
 * Force-drop a game session: close its WebSocket, MCP HTTP transport, or
 * headless connection. For WebSockets, always calls `closeGameSession` after
 * `ws.close()` so hosts without an `on('close')` hook still release bodies.
 * MCP HTTP uses `transport.close()` → dispose → `closeMcpSession`. Stdio MCP
 * falls back to `closeGameSession` when no HTTP transport is registered.
 *
 * @returns {{ ok: true, sessionId: string, kind: string } | null}
 */
export function terminateSession(sessionId, { reason } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    const conn = getConnection(sessionId);
    if (!conn) return null;

    const kind = conn.kind || 'ws';
    if (kind === 'ws' && conn.ws) {
        try {
            conn.ws.close(1000, typeof reason === 'string' ? reason : undefined);
        } catch {}
        // Always run game cleanup here: `server/index.js` also calls
        // `closeGameSession` on `close`, but embedded tests and other hosts
        // may open sockets without that listener — duplicate calls are safe.
        closeGameSession(sessionId);
        return { ok: true, sessionId, kind: 'ws' };
    }
    if (kind === 'mcp') {
        if (closeMcpHttpSessionForGameSession(sessionId)) {
            return { ok: true, sessionId, kind: 'mcp' };
        }
        closeGameSession(sessionId);
        return { ok: true, sessionId, kind: 'mcp' };
    }
    closeGameSession(sessionId);
    return { ok: true, sessionId, kind };
}

