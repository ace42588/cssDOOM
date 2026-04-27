/**
 * SGNL services bridge — server-side.
 *
 * Wires four SGNL channels into the engine's `services` facade so every
 * game module runs unchanged on the server:
 *
 *   - Access Evaluations (`evaluation.js`) — synchronous decision calls.
 *   - CAEP / SSF (`caep.js`) — session-established SETs.
 *   - SCIM 2.0 Entity Push (`scim.js`) — one SCIM User per connected
 *     player session. SGNL's SCIM adapter only accepts /Users and
 *     /Groups, so anything else stays out of this channel.
 *   - Event Push (`events.js`) — discrete state-change events for
 *     every non-player entity (doors, lifts, crushers, pickups, keys,
 *     AI actors). SGNL issues the endpoint URL at SoR creation.
 *
 * `createSgnlServices()` exposes a flat contract (markEntityDirty,
 * markPlayerDirty, markMapChanged, flushNow, tickHeartbeat,
 * setMapName) that `src/engine/services.js` re-exports; individual
 * engine modules don't know which underlying channel handles them.
 */

import { randomUUID } from 'node:crypto';

import { evaluateAccess as sgnlEvaluateAccess } from './evaluation.js';
import { emitCaepSessionEstablished } from './caep.js';
import {
    initScimPush,
    markPlayerDirty,
    markMapChanged as markScimMapChanged,
    flushScimNow,
    tickScimHeartbeat,
    registerScimPlayer,
    unregisterScimPlayer,
} from './scim.js';
import {
    initEventsPush,
    markEntityDirty,
    markMapChanged as markEventsMapChanged,
    flushEventsNow,
    tickEventsHeartbeat,
} from './events.js';
import { startSgnlAdapter } from './adapter/index.js';

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
    registerScimPlayer(sessionId, {
        displayName: meta.displayName || meta.email || `session:${sessionId}`,
    });
}

export function unregisterSession(sessionId) {
    sessions.delete(sessionId);
    unregisterScimPlayer(sessionId);
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

/** Bootstrap SCIM + Event Push + the SGNL gRPC map adapter. Idempotent;
 * each channel is a no-op when its env is missing. */
export async function initSgnl(initialMapName = 'E1M1') {
    await Promise.all([
        initScimPush(initialMapName),
        initEventsPush(initialMapName),
    ]);
    try {
        await startSgnlAdapter();
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[sgnl] adapter failed to start', err);
    }
}

function markMapChanged(mapName) {
    markScimMapChanged(mapName);
    markEventsMapChanged(mapName);
}

async function flushNow() {
    await Promise.all([flushScimNow(), flushEventsNow()]);
}

function tickHeartbeat(deltaTime) {
    tickScimHeartbeat(deltaTime);
    tickEventsHeartbeat(deltaTime);
}

/**
 * Build the services implementation passed to `setGameServices()` so
 * engine modules (doors, lifecycle, pickups, crushers, lifts, …) can
 * reach SGNL without importing any channel directly.
 *
 * Routing:
 *   - `markPlayerDirty` → SCIM Users push.
 *   - `markEntityDirty` → Event Push (non-player entities).
 *   - map / flush / tick fan out to both channels.
 */
export function createSgnlServices() {
    return {
        async evaluateAccess(controllerId, assetId, action) {
            const principalId = resolvePrincipalId(controllerId);
            if (!principalId) return { allowed: true, skipped: true };
            return sgnlEvaluateAccess(principalId, assetId, action);
        },
        markEntityDirty,
        markPlayerDirty,
        markMapChanged,
        flushNow,
        tickHeartbeat,
        setMapName: markMapChanged,
    };
}
