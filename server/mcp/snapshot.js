/**
 * Read-side helpers for MCP tools.
 *
 * These produce plain JSON-serializable views of authoritative server state
 * so MCP tools can return them directly. The full per-tick snapshot lives
 * in the per-session ring (`sessions.js#getRing`); these helpers are for
 * "give me the world right now" reads instead of "what's the latest pushed
 * snapshot for this session".
 */

import { getMarine, state } from '../../src/game/state.js';
import { ENEMIES } from '../../src/game/constants.js';
import { getThingIndex, getActorIndex } from '../../src/game/things/registry.js';
import {
    getControlledFor,
    getSessionIdControlling,
    listHumanControlledEntries,
} from '../../src/game/possession.js';
import { entityId } from '../assignment.js';
import { poseOf } from '../../src/game/entity/caps.js';
import { listConnections, getConnection } from '../connections.js';
import { getMapPayload, getCurrentTick } from '../world.js';
import { normalizeAngle } from '../../src/game/math/angle.js';

const ENEMY_LABELS = {
    3004: 'Zombieman',
    9: 'Shotgun Guy',
    3001: 'Imp',
    3002: 'Demon',
    58: 'Spectre',
    3003: 'Baron of Hell',
};

function enemyLabel(type) {
    return ENEMY_LABELS[type] || `Enemy #${type}`;
}

function isLiveEnemy(thing) {
    if (!thing) return false;
    if (!thing.ai) return false;
    if (!ENEMIES.has(thing.type)) return false;
    if (thing.collected) return false;
    return (thing.hp ?? 0) > 0;
}

export function snapshotPlayer() {
    return {
        x: getMarine().x,
        y: getMarine().y,
        z: getMarine().z,
        angle: normalizeAngle(getMarine().viewAngle),
        floorHeight: getMarine().floorHeight,
        health: getMarine().hp,
        armor: getMarine().armor,
        armorType: getMarine().armorType,
        ammo: { ...getMarine().ammo },
        maxAmmo: { ...getMarine().maxAmmo },
        currentWeapon: getMarine().currentWeapon,
        ownedWeapons: [...getMarine().ownedWeapons],
        collectedKeys: [...getMarine().collectedKeys],
        powerups: { ...getMarine().powerups },
        hasBackpack: Boolean(getMarine().hasBackpack),
        isDead: getMarine().deathMode === 'gameover',
        isAiDead: getMarine().deathMode === 'ai',
        isFiring: Boolean(getMarine().isFiring),
        controllingSessionId: getSessionIdControlling(getMarine()) ?? null,
    };
}

export function snapshotEnemy(thing, originX = getMarine().x, originY = getMarine().y) {
    const aIdx = getActorIndex(thing);
    const idx = aIdx >= 0 ? aIdx : getThingIndex(thing);
    const dx = (thing.x ?? 0) - originX;
    const dy = (thing.y ?? 0) - originY;
    return {
        id: idx,
        type: thing.type,
        label: enemyLabel(thing.type),
        x: thing.x,
        y: thing.y,
        z: thing.z ?? thing.floorHeight ?? 0,
        facing: typeof thing.facing === 'number' ? normalizeAngle(thing.facing) : null,
        viewAngle: typeof thing.viewAngle === 'number' ? normalizeAngle(thing.viewAngle) : null,
        hp: thing.hp ?? null,
        maxHp: thing.maxHp ?? null,
        aiState: thing.ai?.state ?? null,
        controllingSessionId: getSessionIdControlling(thing) ?? null,
        distanceToOrigin: Math.hypot(dx, dy),
    };
}

export function snapshotDoor(entry) {
    const doorEntity = entry.doorEntity;
    const pendingRequests = (doorEntity?.pendingRequests ?? []).map((r) => ({
        id: r.id,
        interactorId: r.interactorId,
        interactorLabel: r.interactorLabel,
        approachSide: r.approachSide,
    }));
    return {
        sectorIndex: entry.sectorIndex,
        open: Boolean(entry.open),
        passable: Boolean(entry.passable),
        keyRequired: entry.keyRequired ?? null,
        sessionId: getSessionIdControlling(doorEntity) ?? null,
        camera: doorEntity
            ? {
                x: doorEntity.x,
                y: doorEntity.y,
                z: doorEntity.z,
                viewAngle: normalizeAngle(doorEntity.viewAngle ?? 0),
            }
            : null,
        pendingRequests,
    };
}

export function listEnemies({ originX = getMarine().x, originY = getMarine().y, maxDistance = Infinity, limit = Infinity } = {}) {
    const out = [];
    for (let i = 1; i < state.actors.length; i++) {
        const thing = state.actors[i];
        if (!thing || !isLiveEnemy(thing)) continue;
        const snap = snapshotEnemy(thing, originX, originY);
        if (snap.distanceToOrigin > maxDistance) continue;
        out.push(snap);
    }
    for (const thing of state.things) {
        if (!thing || !isLiveEnemy(thing)) continue;
        const snap = snapshotEnemy(thing, originX, originY);
        if (snap.distanceToOrigin > maxDistance) continue;
        out.push(snap);
    }
    out.sort((a, b) => a.distanceToOrigin - b.distanceToOrigin);
    if (out.length > limit) out.length = limit;
    return out;
}

export function listDoors() {
    const out = [];
    for (const entry of state.doorState.values()) {
        out.push(snapshotDoor(entry));
    }
    out.sort((a, b) => a.sectorIndex - b.sectorIndex);
    return out;
}

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
 * Combined "give me the world" view — what the agent's session is doing,
 * who else is around, what enemies are alive, what doors exist. This is
 * the read most agents will start with.
 */
export function snapshotWorld(selfSessionId) {
    const conn = selfSessionId ? getConnection(selfSessionId) : null;
    const controlled = conn ? getControlledFor(conn.sessionId) : null;
    const controlledPose = poseOf(controlled);
    const { name: mapName } = getMapPayload();
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
                  position: controlledPose
                      ? { x: controlledPose.x, y: controlledPose.y, z: controlledPose.z, angle: controlledPose.angle }
                      : null,
                  agent: conn.kind === 'mcp' ? normalizeAgentIdentity(conn.agentIdentity) : null,
              }
            : null,
        marine: snapshotPlayer(),
        enemies: listEnemies(),
        doors: listDoors(),
        players: listPlayers(selfSessionId),
    };
}

export {
    enemyLabel,
    isLiveEnemy,
    entityId,
    listHumanControlledEntries,
};
