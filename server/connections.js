/**
 * Tracks connected clients and the per-session state the server needs
 * to run the game loop (role, controlled body, latest input, follow target).
 *
 * The WebSocket is owned here; the rest of the server talks to connections
 * through this module's API so we can swap transports later without rippling
 * changes through `world.js` or `assignment.js`.
 */

import { randomUUID } from 'node:crypto';
import { emptyInput, ROLE } from './net.js';

/**
 * @typedef {Object} Connection
 * @property {string} sessionId
 * @property {import('ws').WebSocket} ws
 * @property {'player'|'spectator'} role
 * @property {string|null} controlledId   // opaque id referring to an entity
 * @property {string|null} followTargetId // spectators only
 * @property {ReturnType<emptyInput>} input
 * @property {number} lastInputSeq
 * @property {number} joinedAt
 */

/** @type {Map<string, Connection>} */
const connections = new Map();

export function addConnection(ws) {
    const sessionId = randomUUID();
    /** @type {Connection} */
    const conn = {
        sessionId,
        ws,
        role: ROLE.SPECTATOR,
        controlledId: null,
        followTargetId: null,
        input: emptyInput(),
        lastInputSeq: 0,
        joinedAt: Date.now(),
    };
    connections.set(sessionId, conn);
    return conn;
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

/** Send a JSON message to a single connection, swallowing socket errors. */
export function send(conn, message) {
    if (!conn || !conn.ws) return;
    try {
        conn.ws.send(JSON.stringify(message));
    } catch {
        // connection is going away; `close` will tidy up
    }
}

/** Broadcast the same message to every currently-connected session. */
export function broadcast(message) {
    const payload = JSON.stringify(message);
    for (const conn of connections.values()) {
        try { conn.ws.send(payload); } catch {}
    }
}
