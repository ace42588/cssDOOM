/**
 * Per-MCP-client session lifecycle.
 *
 * Each MCP client connection becomes one headless `Connection` in
 * `server/connections.js`, with a per-session ring buffer that captures the
 * latest world snapshot, role-change announcement, and any in-flight map
 * load payload. Tools read from this ring instead of waiting for a push.
 *
 * The lifecycle here mirrors `handleConnection()` in `server/index.js`
 * for WebSocket clients:
 *   1. addHeadlessConnection
 *   2. registerSession + emitSessionEstablished (SGNL bridge)
 *   3. assignOnJoin → claim a body or become a spectator
 *   4. on disconnect: releaseOnDisconnect, removeConnection, unregisterSession
 *
 * The ring buffer keeps only the latest snapshot per slot — the engine
 * generates one snapshot per tick (~17 Hz outbound), and an agent reading at
 * its own pace just wants the freshest world view, not a queue of stale
 * frames. This avoids unbounded memory growth if an agent stops polling.
 */

import {
    addHeadlessConnection,
    getConnection,
} from '../connections.js';
import {
    closeGameSession,
    initializeGameSession,
} from '../session-lifecycle.js';
import { MSG } from '../net.js';
import { getControlledFor } from '../../src/game/possession.js';
import { rolePromptFor } from './role.js';
import { disposeActorSession } from './tools/actor.js';

function readClaimTtlMs() {
    const raw = Number(process.env.MCP_CLAIM_TTL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

const CLAIM_TTL_MS = readClaimTtlMs();

/** @type {Map<string, { controlledEntityId: string, role: string, followTargetId: string|null, expiresAt: number }>} */
const recentAgentClaims = new Map();

function pruneExpiredClaims(now = Date.now()) {
    for (const [k, v] of recentAgentClaims) {
        if (v.expiresAt <= now) recentAgentClaims.delete(k);
    }
}

/** Key for sticky body reassignment after MCP reconnect (same agent identity). */
export function claimKeyFor(conn) {
    const a = conn.agentIdentity;
    if (!a || typeof a !== 'object') return null;
    if (a.source === 'client' && a.agentId) return `agent:${a.agentId}`;
    if (a.fingerprint) return `fp:${a.fingerprint}`;
    return null;
}

export function peekRecentClaim(agentKey) {
    if (!agentKey) return null;
    pruneExpiredClaims();
    const v = recentAgentClaims.get(agentKey);
    if (!v || v.expiresAt <= Date.now()) {
        if (v) recentAgentClaims.delete(agentKey);
        return null;
    }
    return {
        controlledEntityId: v.controlledEntityId,
        role: v.role,
        followTargetId: v.followTargetId,
    };
}

export function recordRecentClaim(agentKey, claim) {
    if (!agentKey || !claim.controlledEntityId) return;
    recentAgentClaims.set(agentKey, {
        controlledEntityId: claim.controlledEntityId,
        role: claim.role,
        followTargetId: claim.followTargetId ?? null,
        expiresAt: Date.now() + CLAIM_TTL_MS,
    });
}

export function clearRecentClaim(agentKey) {
    if (agentKey) recentAgentClaims.delete(agentKey);
}

/**
 * sessionId → ring buffer of the most recent server-to-client messages.
 * Each slot holds the latest message of its type (we only care about
 * the freshest snapshot / role change / map load).
 */
const ringsBySession = new Map();

function newRing() {
    return {
        snapshot: null,
        roleChange: null,
        mapLoad: null,
        welcome: null,
        // Append-only event log capped at MAX_LOG_ENTRIES so agents that poll
        // can see things like "your map just changed" without having to diff
        // snapshots themselves. Cleared by `world-poll-events` on read.
        log: [],
    };
}

const MAX_LOG_ENTRIES = 64;

function pushLog(ring, entry) {
    ring.log.push({ ...entry, at: Date.now() });
    if (ring.log.length > MAX_LOG_ENTRIES) {
        ring.log.splice(0, ring.log.length - MAX_LOG_ENTRIES);
    }
}

function captureMessage(sessionId, message) {
    const ring = ringsBySession.get(sessionId);
    if (!ring) return;
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
        case MSG.SNAPSHOT:
            ring.snapshot = message;
            break;
        case MSG.ROLE_CHANGE:
            ring.roleChange = message;
            pushLog(ring, { kind: 'roleChange', role: message.role, controlledId: message.controlledId });
            pushLog(ring, { kind: 'rolePrompt', role: rolePromptFor(getControlledFor(sessionId)) });
            break;
        case MSG.MAP_LOAD:
            ring.mapLoad = { mapName: message.mapName, mapData: message.mapData };
            pushLog(ring, { kind: 'mapLoad', mapName: message.mapName });
            break;
        case MSG.WELCOME:
            ring.welcome = message;
            break;
        case MSG.NOTICE:
            pushLog(ring, {
                kind: 'notice',
                code: message.code,
                message: message.message,
                secondsUntilAction: message.secondsUntilAction,
            });
            break;
        case MSG.BYE:
            pushLog(ring, { kind: 'bye', reason: message.reason });
            break;
        default:
            break;
    }
}

/**
 * Open a new MCP-backed session. Mirrors the WS `handleConnection` but
 * captures outbound messages into a ring buffer instead of pushing them
 * over a socket.
 *
 * Returns the `Connection` (with `sessionId`, `role`, `controlledId`, …).
 * Callers should hold onto the sessionId and pass it to tool helpers; on
 * shutdown call `closeMcpSession(sessionId)`.
 */
export function openMcpSession({ displayName, agentIdentity } = {}) {
    const ring = newRing();
    const conn = addHeadlessConnection({
        outboundSink: (message) => captureMessage(conn.sessionId, message),
        kind: 'mcp',
        agentIdentity: null,
    });
    conn.agentIdentity = normalizeAgentIdentity(conn.sessionId, agentIdentity);
    ringsBySession.set(conn.sessionId, ring);

    const agentKey = claimKeyFor(conn);
    const claim = peekRecentClaim(agentKey);
    const assignOpts = claim?.controlledEntityId
        ? { preferredControlledId: claim.controlledEntityId }
        : {};
    initializeGameSession(conn, {
        displayName: displayName || `mcp:${conn.sessionId}`,
        assignmentOptions: assignOpts,
    });
    if (claim && conn.controlledId === claim.controlledEntityId) {
        clearRecentClaim(agentKey);
    }

    const ringAfter = ringsBySession.get(conn.sessionId);
    if (ringAfter) {
        pushLog(ringAfter, { kind: 'rolePrompt', role: rolePromptFor(getControlledFor(conn.sessionId)) });
    }

    return conn;
}

function normalizeAgentIdentity(sessionId, agentIdentity) {
    if (agentIdentity && typeof agentIdentity === 'object') {
        return {
            source: agentIdentity.source === 'client' ? 'client' : 'fingerprint',
            agentId: agentIdentity.agentId || `fp:${sessionId}`,
            agentName: agentIdentity.agentName || agentIdentity.agentId || `mcp:${sessionId.slice(0, 8)}`,
            fingerprint: agentIdentity.fingerprint || sessionId.slice(0, 16),
            runtime: agentIdentity.runtime || null,
            clientName: agentIdentity.clientName || null,
            clientVersion: agentIdentity.clientVersion || null,
            firstSeenAt: Number.isFinite(agentIdentity.firstSeenAt) ? agentIdentity.firstSeenAt : Date.now(),
        };
    }
    const fingerprint = sessionId.slice(0, 16);
    return {
        source: 'fingerprint',
        agentId: `fp:${fingerprint}`,
        agentName: `mcp:${sessionId.slice(0, 8)}`,
        fingerprint,
        runtime: null,
        clientName: null,
        clientVersion: null,
        firstSeenAt: Date.now(),
    };
}

/** Close an MCP session: release its body, drop it from the registry. */
export function closeMcpSession(sessionId) {
    const conn = getConnection(sessionId);
    if (!conn) {
        ringsBySession.delete(sessionId);
        return;
    }
    const agentKey = claimKeyFor(conn);
    if (agentKey && conn.controlledId) {
        recordRecentClaim(agentKey, {
            controlledEntityId: conn.controlledId,
            role: conn.role,
            followTargetId: conn.followTargetId,
        });
    }
    closeGameSession(sessionId);
    ringsBySession.delete(sessionId);
    disposeActorSession(sessionId);
}

/** Get the per-session ring buffer (latest snapshot/role/map + event log). */
export function getRing(sessionId) {
    return ringsBySession.get(sessionId) || null;
}

/** Drain the per-session event log (returns a copy and clears the ring). */
export function drainLog(sessionId) {
    const ring = ringsBySession.get(sessionId);
    if (!ring) return [];
    const out = ring.log;
    ring.log = [];
    return out;
}
