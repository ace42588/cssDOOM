/**
 * SGNL services bridge — server-side.
 *
 * Wires the three SGNL channels (Access Evaluations, CAEP, SCIM) into the
 * engine's `services` facade so every game module runs unchanged on the
 * server. The facade only knows an abstract `controllerId` for access
 * queries; we map it to a principal id here via an internal session
 * registry (populated by `registerSession` on WS connect).
 *
 * Exposes:
 *   - createSgnlServices(): services impl for setGameServices()
 *   - registerSession(sessionId, meta): associate a session id with a
 *     principalId / email (used by CAEP + evaluations)
 *   - unregisterSession(sessionId)
 *   - emitSessionEstablished(sessionId): push a CAEP SET for a session
 *   - initSgnl(initialMapName): bootstrap SCIM push (fire-and-forget)
 */

import { randomUUID } from 'node:crypto';

import { evaluateAccess as sgnlEvaluateAccess } from './evaluation.js';
import { emitCaepSessionEstablished } from './caep.js';
import {
    initScimPush,
    markPlayerDirty,
    markGameStateDirty,
    markAllScimDirty,
    flushScimNow,
    tickScimHeartbeat,
    setScimMapName,
} from './scim.js';

const sessions = new Map();

export function registerSession(sessionId, meta = {}) {
    if (!sessionId) return;
    const principalId = meta.principalId
        || process.env.SGNL_DEFAULT_PRINCIPAL_ID
        || `session:${sessionId}`;
    sessions.set(sessionId, {
        principalId,
        email: meta.email || process.env.CAEP_SUBJECT_EMAIL?.trim() || null,
        opaqueId: meta.opaqueId || randomUUID(),
    });
}

export function unregisterSession(sessionId) {
    sessions.delete(sessionId);
}

function resolvePrincipalId(controllerId) {
    if (!controllerId || controllerId === 'local') {
        return process.env.SGNL_DEFAULT_PRINCIPAL_ID || null;
    }
    const meta = sessions.get(controllerId);
    if (meta) return meta.principalId;
    return process.env.SGNL_DEFAULT_PRINCIPAL_ID || null;
}

/** Push a CAEP session-established SET for this session (fire-and-forget). */
export function emitSessionEstablished(sessionId) {
    const meta = sessions.get(sessionId);
    if (!meta) return;
    void emitCaepSessionEstablished({
        email: meta.email || undefined,
        opaqueId: meta.opaqueId,
    });
}

/** Bootstrap SCIM push. Idempotent; no-op when env is missing. */
export async function initSgnl(initialMapName = 'E1M1') {
    await initScimPush(initialMapName);
}

/**
 * Build the services implementation to pass to `setGameServices()` so the
 * engine modules (doors, lifecycle, pickups, crushers, lifts, …) can talk
 * to SGNL without importing it directly.
 */
export function createSgnlServices() {
    return {
        async evaluateAccess(controllerId, assetId, action) {
            const principalId = resolvePrincipalId(controllerId);
            if (!principalId) return { allowed: true, skipped: true };
            return sgnlEvaluateAccess(principalId, assetId, action);
        },
        markPlayerDirty,
        markGameStateDirty,
        markAllDirty: markAllScimDirty,
        flushNow: flushScimNow,
        tickHeartbeat: tickScimHeartbeat,
        setMapName: setScimMapName,
    };
}
