/**
 * Capability predicates and pose helpers. No classes; no allocations.
 * `possession.js` must not import this module (avoid cycles); callers pass entities in.
 */

import { WEAPONS } from '../constants.js';
import { getMarineActor } from '../state.js';
import { normalizeAngle } from '../math/angle.js';

export function isActorAlive(actor) {
    if (!actor) return false;
    if (actor === getMarineActor()) return actor.hp > 0 && !actor.deathMode;
    if (actor.__isDoorEntity) return true;
    if (!actor.ai) return false;
    if (actor.collected) return false;
    return (actor.hp ?? 0) > 0;
}

/** Same gate as snapshot `entityIsControllableSnapshot` / assignment `controlledBodyIsAlive` for bodies. */
export function isControllableBody(entity) {
    return isActorAlive(entity);
}

/**
 * True when the actor's loadout contains more than one weapon slot — so
 * `ownedWeapons.size > 1`. Monsters with a single intrinsic weapon (or actors
 * without a weapon loadout at all) fail the check and therefore ignore
 * `switchWeapon` inputs / HUD weapon slots.
 */
export function canSwitchWeapons(entity) {
    if (!entity) return false;
    const owned = entity.ownedWeapons;
    if (!owned) return false;
    if (owned instanceof Set) return owned.size > 1;
    if (Array.isArray(owned)) return owned.length > 1;
    if (typeof owned.size === 'number') return owned.size > 1;
    if (typeof owned.length === 'number') return owned.length > 1;
    return false;
}

export function canFire(entity) {
    if (!entity) return false;
    if (entity.__isDoorEntity) return false;
    if (entity === getMarineActor()) {
        const w = WEAPONS[entity.currentWeapon];
        if (!w) return false;
        if (!w.ammoType) return true;
        return entity.ammo[w.ammoType] >= (w.ammoPerShot || 0);
    }
    if (entity.ai) return (entity.hp ?? 0) > 0 && !entity.collected;
    return false;
}

/** Pose for MCP / UI (angles normalized to [-pi, pi]). */
export function poseOf(entity) {
    if (!entity) return null;
    if (entity === getMarineActor()) {
        const m = getMarineActor();
        return {
            kind: 'marine',
            x: m.x,
            y: m.y,
            z: m.z,
            angle: normalizeAngle(m.viewAngle),
        };
    }
    if (entity.__isDoorEntity) {
        return {
            kind: 'door',
            x: entity.x,
            y: entity.y,
            z: entity.z ?? 0,
            angle: normalizeAngle(entity.viewAngle ?? 0),
        };
    }
    const angle = typeof entity.viewAngle === 'number'
        ? entity.viewAngle
        : ((entity.facing ?? 0) - Math.PI / 2);
    return {
        kind: 'enemy',
        x: entity.x,
        y: entity.y,
        z: entity.z ?? entity.floorHeight ?? 0,
        angle: normalizeAngle(angle),
    };
}
