/**
 * Server-side "give me the world right now" view.
 *
 * Record-shaping logic for a single actor lives in
 * [src/game/snapshot.js](../../src/game/snapshot.js) so both the Node server
 * (MCP tools, admin REST, SGNL push) and the browser bundle (WebMCP
 * tools) produce byte-identical payloads for the same actor. This module
 * layers the server-only concerns on top of the shared helpers:
 * connection roster, map name + tick, and the caller's `self` block.
 *
 * The full per-tick snapshot lives in the per-session ring
 * (`server/mcp/sessions.js#getRing`); these helpers are for "give me the
 * world right now" reads instead of "what's the latest pushed snapshot".
 */

import { getMarineActor } from '../../src/game/state.js';
import { getControlledFor } from '../../src/game/possession.js';
import { poseOf } from '../../src/game/entity/caps.js';
import { listConnections, getConnection } from '../connections.js';
import { getMapPayload, getCurrentTick } from '../world.js';
import {
    snapshotActor,
    snapshotDoor,
    listActors,
    listDoors,
    isLiveActor,
} from '../../src/game/snapshot.js';

export {
    snapshotActor,
    snapshotDoor,
    listActors,
    listDoors,
    isLiveActor,
};

/**
 * Player roster — every connected session, what they control, and how
 * they're connected (ws / mcp). The session whose id matches `selfSessionId`
 * is tagged with `self: true` so an agent can tell itself apart.
 */
export function listPlayers(selfSessionId = null) {
    const out = [];
    for (const conn of listConnections()) {
        const entity = getControlledFor(conn.sessionId);
        const pose = poseOf(entity);
        out.push({
            sessionId: conn.sessionId,
            self: selfSessionId === conn.sessionId,
            kind: conn.kind || 'ws',
            role: conn.role,
            controlledId: conn.controlledId,
            controlledKind: pose?.kind ?? null,
            position: pose ? { x: pose.x, y: pose.y, z: pose.z, angle: pose.angle } : null,
            joinedAt: conn.joinedAt,
            agent: conn.kind === 'mcp' ? normalizeAgentIdentity(conn.agentIdentity) : null,
        });
    }
    return out;
}

function normalizeAgentIdentity(identity) {
    if (!identity || typeof identity !== 'object') return null;
    return {
        source: identity.source === 'client' ? 'client' : 'fingerprint',
        agentId: identity.agentId || null,
        agentName: identity.agentName || null,
        fingerprint: identity.fingerprint || null,
        runtime: identity.runtime || null,
        clientName: identity.clientName || null,
        clientVersion: identity.clientVersion || null,
        firstSeenAt: Number.isFinite(identity.firstSeenAt) ? identity.firstSeenAt : null,
    };
}

/**
 * Unified "give me the world" view. Actors (marine + monsters, live and
 * dead) sit in a single list; doors stay separate (they're not actors);
 * the player roster is the connection/session list.
 */
export function snapshotWorld(selfSessionId) {
    const conn = selfSessionId ? getConnection(selfSessionId) : null;
    const controlled = conn ? getControlledFor(conn.sessionId) : null;
    const controlledPose = poseOf(controlled);
    // Distance origin is the caller's controlled body so every
    // `distanceToOrigin` in the returned actor / enemy list reflects
    // "distance from me". Spectators (and the bootstrap call with no
    // session) fall back to the marine so the listing still has a
    // meaningful anchor instead of dumping everything at (0, 0).
    const anchor = controlled || getMarineActor();
    const { name: mapName } = getMapPayload();
    const originX = anchor?.x ?? 0;
    const originY = anchor?.y ?? 0;
    return {
        tick: getCurrentTick(),
        serverTime: Date.now(),
        mapName,
        self: conn
            ? {
                  sessionId: conn.sessionId,
                  kind: conn.kind || 'ws',
                  role: conn.role,
                  controlledId: conn.controlledId,
                  controlledKind: controlledPose?.kind ?? null,
                  controlledActor: controlled
                      ? snapshotActor(controlled, { originX, originY })
                      : null,
                  position: controlledPose
                      ? { x: controlledPose.x, y: controlledPose.y, z: controlledPose.z, angle: controlledPose.angle }
                      : null,
                  agent: conn.kind === 'mcp' ? normalizeAgentIdentity(conn.agentIdentity) : null,
              }
            : null,
        actors: listActors({ originX, originY }),
        doors: listDoors(),
        players: listPlayers(selfSessionId),
    };
}
