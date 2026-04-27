import {
    getConnection,
    listPlayerConnections,
    removeConnection,
    send,
} from './connections.js';
import { releaseOnDisconnect } from './assignment.js';
import { MSG } from './net.js';
import { unregisterSession } from './sgnl/index.js';
import { closeMcpSession } from './mcp/sessions.js';

function readTimeoutMs(envName, fallbackMs) {
    const raw = Number(process.env[envName]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallbackMs;
}

const IDLE_WARNING_MS = readTimeoutMs('IDLE_WARNING_MS', 270000);
const IDLE_DROP_MS = readTimeoutMs('IDLE_DROP_MS', 300000);

export function tickIdleChecks(now, onRoleChange = () => {}) {
    void onRoleChange;
    for (const conn of listPlayerConnections()) {
        if (conn.kind === 'mcp') continue;
        const idleMs = now - (conn.lastActiveAt || conn.joinedAt || now);
        if (idleMs < IDLE_WARNING_MS) continue;
        if (idleMs < IDLE_DROP_MS) {
            if (conn.idleWarnedAt) continue;
            send(conn, {
                type: MSG.NOTICE,
                code: 'idle-warning',
                message: 'Idle: disconnecting in 30 seconds',
                secondsUntilAction: Math.ceil((IDLE_DROP_MS - idleMs) / 1000),
            });
            conn.idleWarnedAt = now;
            continue;
        }
        dropIdleController(conn);
    }
}

function dropIdleController(conn) {
    send(conn, {
        type: MSG.NOTICE,
        code: 'idle-drop',
        message: 'Disconnected for idleness',
    });
    closeConnection(conn);
}

function closeConnection(conn) {
    const existing = getConnection(conn.sessionId);
    if (!existing) return;
    if (existing.kind === 'mcp') {
        closeMcpSession(existing.sessionId);
        return;
    }
    releaseOnDisconnect(existing);
    removeConnection(existing.sessionId);
    unregisterSession(existing.sessionId);
    if (existing.ws) {
        try {
            existing.ws.close(4001, 'idle');
        } catch {}
    }
}

