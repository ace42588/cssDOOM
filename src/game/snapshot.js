/**
 * Canonical actor snapshot shape — shared by server (MCP tools, admin REST,
 * SGNL push) and browser (WebMCP mirror tools).
 *
 * All actors — marine, spawned monsters, legacy thing-only AI — render into
 * the same record so agent code never has to branch on "is this the marine"
 * to read hp / pose / inventory. Doors get their own helper because they
 * are not actors (no vitals, no loadout) but they do participate in
 * possession and are listed alongside actors by `snapshotWorld`.
 *
 * Record shape (see Slice E plan):
 *   {
 *     id:   'actor:<slot>' | 'thing:<idx>',
 *     type: thing-type integer (1 for marine, 3001 imp, …),
 *     kind: 'marine' | 'enemy' | 'thing',
 *     label: human-readable ('Marine', 'Imp', …),
 *     pose: { x, y, z, angle, facing, floorHeight },
 *     vitals: { hp, maxHp, armor, armorType, isDead, isAiDead },
 *     loadout?: { currentWeapon, ammo, maxAmmo, ownedWeapons, isFiring, powerups },
 *     inventory?: { hasBackpack, collectedKeys, canCollectPickups },
 *     ai?: { state, hostile, faction, target },
 *     controller: { sessionId } | null,
 *     onDeath: { mode },
 *     attributes: { hazardSusceptible, canTriggerWalkOver },
 *     distanceToOrigin?: number,
 *   }
 *
 * Capability blocks live on the actor as of Slices B–D; this module is
 * a pure record-shaper, so it can be imported from both the Node server
 * and the browser bundle without pulling in transport-specific deps.
 */

import {
    state,
    getMarineActor,
    MARINE_ACTOR_TYPE,
} from './state.js';
import { ENEMIES } from './constants.js';
import { getActorIndex, getThingIndex } from './things/registry.js';
import { getSessionIdControlling } from './possession.js';
import { normalizeAngle } from './math/angle.js';

const ENEMY_LABELS = {
    3004: 'Zombieman',
    9: 'Shotgun Guy',
    3001: 'Imp',
    3002: 'Demon',
    58: 'Spectre',
    3003: 'Baron of Hell',
};

export function enemyLabel(type) {
    return ENEMY_LABELS[type] || `Enemy #${type}`;
}

/** Stable canonical id for an actor (no doors; doors use their own path). */
export function actorIdOf(entity) {
    if (!entity) return null;
    const aIdx = getActorIndex(entity);
    if (aIdx >= 0) return `actor:${aIdx}`;
    const tIdx = getThingIndex(entity);
    return tIdx >= 0 ? `thing:${tIdx}` : null;
}

/** Broad category used by agents — 'marine' | 'enemy' | 'thing'. */
export function kindOfActor(entity) {
    if (!entity) return 'unknown';
    if (entity.type === MARINE_ACTOR_TYPE) return 'marine';
    if (entity.ai && ENEMIES.has(entity.type)) return 'enemy';
    return 'thing';
}

export function labelOfActor(entity) {
    if (!entity) return '';
    if (entity.type === MARINE_ACTOR_TYPE) return 'Marine';
    return enemyLabel(entity.type);
}

/** True if the actor is alive and eligible for combat/possession. */
export function isLiveActor(entity) {
    if (!entity) return false;
    if (entity.type === MARINE_ACTOR_TYPE) {
        return (entity.hp ?? 0) > 0 && !entity.deathMode;
    }
    if (!entity.ai) return false;
    if (entity.collected) return false;
    return (entity.hp ?? 0) > 0;
}

/** True when an actor will attack the marine by default (hostile AI). */
function isHostileActor(entity) {
    if (!entity || !entity.ai) return false;
    if (entity.brain?.hostile === false) return false;
    return ENEMIES.has(entity.type);
}

/**
 * True when an actor is one of the "combatant" category — it has an AI
 * block (so it fights, is pickable for possession, etc.). Used by SGNL
 * Event Push to cover every fighter on the map, including the marine
 * when it runs under AI (no controller) or when pushed events want to
 * describe player bodies.
 */
export function isCombatantActor(entity) {
    if (!entity) return false;
    if (entity.type === MARINE_ACTOR_TYPE) return true;
    if (!entity.ai) return false;
    return ENEMIES.has(entity.type);
}

function poseRecord(entity) {
    const viewAngle = typeof entity.viewAngle === 'number'
        ? entity.viewAngle
        : ((entity.facing ?? 0) - Math.PI / 2);
    return {
        x: entity.x,
        y: entity.y,
        z: entity.z ?? entity.floorHeight ?? 0,
        angle: normalizeAngle(viewAngle),
        facing: typeof entity.facing === 'number'
            ? normalizeAngle(entity.facing)
            : null,
        floorHeight: entity.floorHeight ?? 0,
    };
}

function vitalsRecord(entity) {
    const hp = entity.hp ?? 0;
    const deathMode = entity.deathMode || null;
    return {
        hp,
        maxHp: entity.maxHp ?? null,
        armor: entity.armor ?? 0,
        armorType: entity.armorType ?? 0,
        isDead: entity.type === MARINE_ACTOR_TYPE
            ? deathMode === 'gameover'
            : hp <= 0 || Boolean(entity.collected),
        isAiDead: deathMode === 'ai',
    };
}

function loadoutRecord(entity) {
    const owned = entity.ownedWeapons;
    if (!owned) return null;
    const ownedArr = Array.from(owned).sort((a, b) => a - b);
    return {
        currentWeapon: entity.currentWeapon ?? null,
        ownedWeapons: ownedArr,
        ammo: entity.ammo ? { ...entity.ammo } : {},
        maxAmmo: entity.maxAmmo ? { ...entity.maxAmmo } : {},
        isFiring: Boolean(entity.isFiring),
        powerups: entity.powerups ? { ...entity.powerups } : {},
    };
}

function inventoryRecord(entity) {
    const inv = entity.inventory || null;
    const keys = entity.collectedKeys;
    if (!keys && !inv) return null;
    return {
        hasBackpack: Boolean(entity.hasBackpack),
        canCollectPickups: Boolean(inv?.canCollectPickups),
        collectedKeys: keys ? Array.from(keys).sort() : [],
    };
}

function aiRecord(entity) {
    const ai = entity.ai;
    if (!ai) return null;
    const brain = entity.brain || null;
    // `ai.target` holds an actor reference; serialise only its stable id
    // (or null) so snapshots stay acyclic for JSON.stringify consumers
    // like the admin REST endpoint.
    let targetId = null;
    if (ai.target && typeof ai.target === 'object') {
        targetId = actorIdOf(ai.target) ?? null;
    }
    return {
        state: ai.state ?? null,
        target: targetId,
        hostile: isHostileActor(entity),
        faction: brain?.faction || null,
        profile: brain?.profile || null,
    };
}

function attributesRecord(entity) {
    const mv = entity.movement || null;
    return {
        hazardSusceptible: Boolean(mv?.hazardSusceptible),
        canTriggerWalkOver: Boolean(mv?.canTriggerWalkOver),
    };
}

/**
 * Canonical snapshot of a single actor. `origin` (default: marine position)
 * is used for the optional `distanceToOrigin` field so sort/filter callers
 * can cheaply compute ranges.
 */
export function snapshotActor(entity, { originX, originY } = {}) {
    if (!entity) return null;
    const id = actorIdOf(entity);
    if (!id) return null;

    const record = {
        id,
        type: entity.type,
        kind: kindOfActor(entity),
        label: labelOfActor(entity),
        pose: poseRecord(entity),
        vitals: vitalsRecord(entity),
        ai: aiRecord(entity),
        controller: {
            sessionId: getSessionIdControlling(entity) ?? null,
        },
        onDeath: {
            mode: entity.onDeath?.mode || null,
        },
        attributes: attributesRecord(entity),
    };
    const loadout = loadoutRecord(entity);
    if (loadout) record.loadout = loadout;
    const inventory = inventoryRecord(entity);
    if (inventory) record.inventory = inventory;

    if (originX != null && originY != null) {
        const dx = (entity.x ?? 0) - originX;
        const dy = (entity.y ?? 0) - originY;
        record.distanceToOrigin = Math.hypot(dx, dy);
    }
    return record;
}

/** Snapshot of a door entity. Doors aren't actors — they get their own shape. */
export function snapshotDoor(doorStateEntry) {
    const doorEntity = doorStateEntry?.doorEntity || null;
    const pendingRequests = (doorEntity?.pendingRequests ?? []).map((r) => ({
        id: r.id,
        interactorId: r.interactorId,
        interactorLabel: r.interactorLabel,
        approachSide: r.approachSide,
    }));
    return {
        sectorIndex: doorStateEntry?.sectorIndex ?? null,
        open: Boolean(doorStateEntry?.open),
        passable: Boolean(doorStateEntry?.passable),
        keyRequired: doorStateEntry?.keyRequired ?? null,
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

/**
 * Iterate every actor entity on the map (marine, actor-slot monsters, and
 * legacy thing-slot AI). Yields the raw entity — callers shape it as needed.
 */
function* iterateActorEntities() {
    for (let i = 0; i < state.actors.length; i++) {
        const a = state.actors[i];
        if (a) yield a;
    }
    for (const t of state.things) {
        if (t && t.ai && ENEMIES.has(t.type)) yield t;
    }
}

/**
 * List actors matching `filter`.
 *   kind?: 'marine' | 'enemy' | 'any'        default 'any'
 *   alive?: boolean                            default undefined (no filter)
 *   hostile?: boolean                          default undefined
 *   controlled?: boolean                       default undefined
 *   originX, originY?: number                  sort/filter origin (default: marine pos)
 *   maxDistance?: number                       drop entries beyond this range
 *   limit?: number                             cap output length
 */
export function listActors(filter = {}) {
    const {
        kind = 'any',
        alive,
        hostile,
        controlled,
        maxDistance = Infinity,
        limit = Infinity,
    } = filter;

    const marine = getMarineActor();
    const originX = filter.originX ?? marine?.x ?? 0;
    const originY = filter.originY ?? marine?.y ?? 0;

    const out = [];
    for (const entity of iterateActorEntities()) {
        const entityKind = kindOfActor(entity);
        if (kind !== 'any' && entityKind !== kind) continue;
        if (alive !== undefined && isLiveActor(entity) !== alive) continue;
        if (hostile !== undefined && isHostileActor(entity) !== hostile) continue;
        if (controlled !== undefined) {
            const sid = getSessionIdControlling(entity);
            if ((sid != null) !== controlled) continue;
        }
        const snap = snapshotActor(entity, { originX, originY });
        if (!snap) continue;
        if (snap.distanceToOrigin != null && snap.distanceToOrigin > maxDistance) continue;
        out.push(snap);
    }
    out.sort((a, b) => (a.distanceToOrigin ?? 0) - (b.distanceToOrigin ?? 0));
    if (out.length > limit) out.length = limit;
    return out;
}

export function listDoors() {
    const out = [];
    for (const entry of state.doorState.values()) {
        out.push(snapshotDoor(entry));
    }
    out.sort((a, b) => (a.sectorIndex ?? 0) - (b.sectorIndex ?? 0));
    return out;
}

