/**
 * Tracks connected clients and the per-session state the server needs
 * to run the game loop (role, controlled body, latest input, follow target).
 *
 * Two transports populate this registry:
 *   - WebSocket clients (`addConnection(ws)`) — humans in browsers.
 *   - Headless MCP clients (`addHeadlessConnection({ outboundSink, kind })`) —
 *     external agents speaking JSON-RPC. They look identical to the rest of
 *     the server (`world.js`, `assignment.js`) because every fan-out path
 *     goes through `send()` / `broadcast()` here, which dispatch to whichever
 *     sink the conn carries (`ws.send` or the MCP `outboundSink`).
 */

import { randomUUID } from 'node:crypto';
import { emptyInput, ROLE } from './net.js';
import { emptyBaseline } from './world.js';

/**
 * @typedef {Object} Connection
 * @property {string} sessionId
 * @property {'ws'|'mcp'} kind         — transport family
 * @property {import('ws').WebSocket|null} ws  — null for headless conns
 * @property {((message: object) => void)|null} outboundSink — set for headless
 * @property {'player'|'spectator'} role
 * @property {string|null} controlledId   // opaque id referring to an entity
 * @property {string|null} followTargetId // spectators only
 * @property {ReturnType<emptyInput>} input
 * @property {number} lastInputSeq
 * @property {number} joinedAt
 * @property {number} lastActiveAt
 * @property {number} idleWarnedAt
 * @property {null|{
 *   source: 'client'|'fingerprint',
 *   agentId: string,
 *   agentName: string,
 *   fingerprint: string,
 *   runtime: string|null,
 *   clientName: string|null,
 *   clientVersion: string|null,
 *   firstSeenAt: number,
 * }} agentIdentity
 * @property {ReturnType<typeof emptyBaseline>} baseline — last-sent state,
 *   diffed against current each tick to produce the delta snapshot.
 */

/** @type {Map<string, Connection>} */
const connections = new Map();

function makeConn({ ws = null, outboundSink = null, kind = 'ws', agentIdentity = null } = {}) {
    const sessionId = randomUUID();
    /** @type {Connection} */
    const conn = {
        sessionId,
        kind,
        ws,
        outboundSink,
        role: ROLE.SPECTATOR,
        controlledId: null,
        followTargetId: null,
        input: emptyInput(),
        lastInputSeq: 0,
        joinedAt: Date.now(),
        lastActiveAt: Date.now(),
        idleWarnedAt: 0,
        agentIdentity,
        baseline: emptyBaseline(),
    };
    connections.set(sessionId, conn);
    return conn;
}

/** Register a new WebSocket-backed connection. */
export function addConnection(ws) {
    return makeConn({ ws, kind: 'ws' });
}

/**
 * Register a new headless connection (e.g. MCP). `outboundSink` receives any
 * server-to-client message that would otherwise have gone over a WebSocket;
 * the caller decides what to do with it (typically: keep the latest snapshot
 * in a ring buffer that tools can read on demand).
 */
export function addHeadlessConnection({ outboundSink, kind = 'mcp', agentIdentity = null } = {}) {
    if (typeof outboundSink !== 'function') {
        throw new TypeError('addHeadlessConnection requires outboundSink(message)');
    }
    return makeConn({ outboundSink, kind, agentIdentity });
}

export function removeConnection(sessionId) {
    const conn = connections.get(sessionId);
    if (!conn) return null;
    connections.delete(sessionId);
    return conn;
}

export function getConnection(sessionId) {
    return connections.get(sessionId) || null;
}

export function listConnections() {
    return [...connections.values()];
}

export function listPlayerConnections() {
    return [...connections.values()].filter((c) => c.role === ROLE.PLAYER);
}

export function listSpectatorConnections() {
    return [...connections.values()].filter((c) => c.role === ROLE.SPECTATOR);
}

export function count() {
    return connections.size;
}

export function bumpActivity(conn, now = Date.now()) {
    if (!conn) return;
    conn.lastActiveAt = now;
    conn.idleWarnedAt = 0;
}

/** Send a JSON message to a single connection, swallowing transport errors. */
export function send(conn, message) {
    if (!conn) return;
    if (conn.outboundSink) {
        try { conn.outboundSink(message); } catch {}
        return;
    }
    if (conn.ws) {
        try {
            conn.ws.send(JSON.stringify(message));
        } catch {
            // connection is going away; `close` will tidy up
        }
    }
}

/** Broadcast the same message to every currently-connected session. */
export function broadcast(message) {
    let serialized = null;
    for (const conn of connections.values()) {
        if (conn.outboundSink) {
            try { conn.outboundSink(message); } catch {}
            continue;
        }
        if (conn.ws) {
            if (serialized === null) serialized = JSON.stringify(message);
            try { conn.ws.send(serialized); } catch {}
        }
    }
}
