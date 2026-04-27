/**
 * Unified attack pipeline plus the marine-UI shell around it.
 *
 * `performAttack(attacker, descriptor)` is the single entry point for every
 * kind of attack in the game — marine weapon fire, AI monster attack, and
 * possessed-monster (body-swap) attack all converge here. The descriptor
 * carries `{ kind, range, damageRoll, pelletCount?, spreadDegrees?,
 * projectileTemplate?, sound?, aimTarget?, aimVector?, isPlayerRocket? }`;
 * every damage-dealing step delegates to `applyDamage()` in `./damage.js`.
 *
 * The marine-specific UI flow — `isFiring`, `startFiring()`, auto-fire
 * interval for the chaingun, ammo deduction, weapon-switch gating — lives
 * in `fireWeapon()` / `fireWeaponFor()` and simply builds a descriptor
 * before invoking `performAttack`. Monster AI / possessed attacks live in
 * `src/game/ai/controller.js` and `src/game/possession.js` and build their
 * own descriptors from `ENEMY_AI_STATS` / `ENEMY_PROJECTILES`.
 */

import { state, getMarineActor } from '../state.js';
import {
    WEAPONS, EYE_HEIGHT, ENEMY_PROJECTILES,
    PLAYER_ROCKET_SPEED, ROCKET_SPLASH_DAMAGE,
} from '../constants.js';
import { getFloorHeightAt } from '../physics/queries.js';
import { rayHitPoint } from '../physics/collision.js';
import { hasLineOfSight } from '../physics/line-of-sight.js';
import { applyDamage } from './damage.js';
import { hasPowerup } from '../actor/pickups.js';
import { isShootableThing } from '../things/geometry.js';
import { playSound } from '../../audio/audio.js';
import { setEnemyState } from '../ai/state.js';
import { forEachRadiusDamageTarget } from './radius.js';
import * as renderer from '../../renderer/index.js';
import { input } from '../../input/index.js';
import { propagateSoundFrom } from '../sound-propagation.js';
import {
    getHorizontalDistance,
    getTotalDistance,
    randomDoomSpreadAngleRadians,
} from '../geometry.js';
import { markPlayerDirty } from '../services.js';
import {
    getControlledFor,
    isHumanControlled,
} from '../possession.js';
import { canFire } from '../entity/caps.js';

const marine = () => getMarineActor();

// ============================================================================
// performAttack — the one true attack entry point
// ============================================================================

/**
 * Resolve `{forwardX, forwardY, viewAngle}` for an attacker given an optional
 * explicit aim target or aim vector. Falls back to the attacker's `viewAngle`
 * (or `facing - PI/2` for monsters that only track facing).
 */
function resolveAim(attacker, aimVector, aimTarget) {
    if (aimTarget && aimTarget !== attacker) {
        const dx = aimTarget.x - attacker.x;
        const dy = aimTarget.y - attacker.y;
        const len = Math.hypot(dx, dy);
        if (len > 0) {
            const forwardX = dx / len;
            const forwardY = dy / len;
            return { forwardX, forwardY, viewAngle: Math.atan2(-forwardX, forwardY) };
        }
    }
    if (aimVector) {
        return {
            forwardX: aimVector.x,
            forwardY: aimVector.y,
            viewAngle: Math.atan2(-aimVector.x, aimVector.y),
        };
    }
    const viewAngle = typeof attacker.viewAngle === 'number'
        ? attacker.viewAngle
        : (attacker.facing ?? 0) - Math.PI / 2;
    return {
        forwardX: -Math.sin(viewAngle),
        forwardY: Math.cos(viewAngle),
        viewAngle,
    };
}

/**
 * Returns true if `entity` is a legal damage target for an attack by
 * `attacker`. Any live actor (marine, possessed monster, AI monster) counts;
 * so do shootable things (barrels). The source is always excluded.
 */
function isAttackable(entity, attacker) {
    if (!entity || entity === attacker) return false;
    if (entity.collected) return false;
    if (entity.deathMode) return false;
    if ((entity.hp ?? 0) <= 0) return false;
    if (entity.ai || typeof entity.currentWeapon === 'number') return true;
    return isShootableThing(entity);
}

/**
 * Adjust hitscan-cone tolerance based on target invisibility. Partial
 * invisibility doubles the effective miss chance by widening the rejection
 * angle.
 */
function coneToleranceFor(target) {
    return hasPowerup(target, 'invisibility') ? 0.97 : 0.99;
}

/**
 * Closest live target along the `(dirX, dirY)` ray from `attacker`, limited
 * by `range`. Iterates every actor and every thing uniformly.
 */
function findAttackableInCone(attacker, dirX, dirY, range) {
    let closestDistance = Infinity;
    let closest = null;

    const scan = (entity) => {
        if (!isAttackable(entity, attacker)) return;
        const dx = entity.x - attacker.x;
        const dy = entity.y - attacker.y;
        const d = Math.hypot(dx, dy);
        if (d === 0 || d > range) return;
        const dot = (dx * dirX + dy * dirY) / d;
        if (dot < coneToleranceFor(entity)) return;
        if (d < closestDistance) {
            closestDistance = d;
            closest = entity;
        }
    };

    for (let i = 0, len = state.actors.length; i < len; i++) scan(state.actors[i]);
    for (let i = 0, len = state.things.length; i < len; i++) scan(state.things[i]);
    return closest;
}

/**
 * Player-rocket template used when the marine (or marine-shaped loadout)
 * fires the rocket launcher. Shape parity with `ENEMY_PROJECTILES` entries
 * plus the player-rocket-specific fields (`type`, `speed`).
 */
const PLAYER_ROCKET_TEMPLATE = Object.freeze({
    sprite: 'MISLA1',
    speed: PLAYER_ROCKET_SPEED,
    size: 11,
    hitSound: 'DSBAREXP',
    type: 'player-rocket',
});

/**
 * Apply an attack described by `descriptor` on behalf of `attacker`. This
 * is the unified entry point for hitscan / melee / projectile attacks.
 *
 * Descriptor fields:
 *   - `kind`:                'hitscan' | 'melee' | 'projectile'
 *   - `range`:               max distance for hitscan / melee cone picking.
 *   - `damageRoll`:          () => number — rolled once per pellet / hit.
 *   - `pelletCount`:         number of rays for pellet weapons (default 1).
 *   - `spreadDegrees`:       half-angle spread per pellet (default 0).
 *   - `projectileTemplate`:  required for `kind === 'projectile'`.
 *   - `sound`:               optional fire SFX played once.
 *   - `aimTarget`:           optional actor to aim at (AI path).
 *   - `aimVector`:           optional `{x,y}` forward vector (marine / body-swap).
 *   - `isPlayerRocket`:      marks a player rocket so `rocketExplosion`
 *                            runs on impact (projectiles.js).
 */
export function performAttack(attacker, descriptor) {
    if (!attacker || !descriptor) return;

    const {
        kind,
        range = 2048,
        damageRoll,
        pelletCount = 1,
        spreadDegrees = 0,
        projectileTemplate = null,
        sound = null,
        aimTarget = null,
        aimVector = null,
        isPlayerRocket = false,
        drawHitscanPuffs = true,
    } = descriptor;

    if (sound) playSound(sound);

    const { forwardX, forwardY, viewAngle } = resolveAim(attacker, aimVector, aimTarget);

    if (kind === 'projectile') {
        if (!projectileTemplate) return;
        spawnAttackProjectile(attacker, projectileTemplate, forwardX, forwardY, {
            aimTarget,
            isPlayerRocket,
            directDamage: damageRoll ? damageRoll() : 0,
        });
        return;
    }

    const attackerFloor = attacker.floorHeight ?? getFloorHeightAt(attacker.x, attacker.y);
    const attackerEyeZ = attackerFloor + EYE_HEIGHT;

    for (let p = 0; p < pelletCount; p++) {
        let dirX = forwardX;
        let dirY = forwardY;
        if (spreadDegrees > 0) {
            const spread = randomDoomSpreadAngleRadians(spreadDegrees);
            dirX = -Math.sin(viewAngle + spread);
            dirY = Math.cos(viewAngle + spread);
        }

        const target = findAttackableInCone(attacker, dirX, dirY, range);

        if (target && hasLineOfSight(attacker, target)) {
            if (kind === 'hitscan' && drawHitscanPuffs) {
                spawnImpactPuff(target.x, target.y, getFloorHeightAt(target.x, target.y));
            }
            if (damageRoll) {
                applyDamage(target, damageRoll(), attacker, { kind });
            }
            continue;
        }

        if (kind === 'hitscan' && drawHitscanPuffs) {
            const wallHit = rayHitPoint(attacker.x, attacker.y, dirX, dirY, range, attackerEyeZ);
            if (wallHit) spawnImpactPuff(wallHit.x, wallHit.y);
        }
    }
}

// ============================================================================
// Marine weapon UI (fire button → performAttack)
// ============================================================================

/**
 * Equips a weapon by slot number. Updates game state and tells the renderer
 * to switch visuals (the renderer decides whether to animate).
 */
export function equipWeapon(slot) {
    const weapon = WEAPONS[slot];
    if (!weapon || !marine().ownedWeapons.has(slot)) return;

    marine().isFiring = false;
    marine().currentWeapon = slot;
    renderer.switchWeapon(weapon.name, weapon.fireRate);
    markPlayerDirty();
}

/** Interval handle for continuous-fire weapons (chaingun). */
let automaticFireInterval = null;

/**
 * Fires the currently equipped marine weapon. Handles the UI shell
 * (isFiring flag, ammo deduction, start/stop firing animation, continuous
 * auto-fire interval) and delegates hit detection to `performAttack`.
 *
 * Based on: linuxdoom-1.10/p_pspr.c weapon action functions.
 */
function fireWeapon() {
    const m = marine();
    if (m.hp <= 0 || m.deathMode || m.isFiring || renderer.isWeaponSwitching()) return;

    if (!canFire(m)) return;
    const weapon = WEAPONS[m.currentWeapon];
    if (!weapon) return;

    if (weapon.ammoType) m.ammo[weapon.ammoType] -= weapon.ammoPerShot;
    markPlayerDirty();
    m.isFiring = true;

    renderer.startFiring();
    performAttack(m, buildMarineAttackDescriptor(m));
    propagateSoundFrom(m);

    if (weapon.continuous && input.fireHeld) {
        stopAutoFire();
        automaticFireInterval = setInterval(() => {
            const ma = marine();
            if (!input.fireHeld || ma.hp <= 0 || ma.deathMode || !canFire(ma)) {
                stopAutoFire();
                return;
            }
            if (weapon.ammoType) ma.ammo[weapon.ammoType] -= weapon.ammoPerShot;
            markPlayerDirty();
            performAttack(ma, buildMarineAttackDescriptor(ma));
            propagateSoundFrom(ma);
        }, weapon.fireRate);
    } else {
        setTimeout(() => {
            marine().isFiring = false;
            if (input.fireHeld) fireWeapon();
        }, weapon.fireRate);
    }
}

/** Stops the continuous-fire interval (chaingun) on release / death / empty. */
function stopAutoFire() {
    if (automaticFireInterval) {
        clearInterval(automaticFireInterval);
        automaticFireInterval = null;
        renderer.stopFiring();
        marine().isFiring = false;
    }
}

/**
 * Server entry: fire the currently possessed body's attack for `sessionId`.
 * Marine: full UI / auto-fire path. Monster: one-shot attack descriptor.
 */
export function fireWeaponFor(sessionId) {
    const entity = getControlledFor(sessionId);
    if (!entity) return;
    if (!canFire(entity)) return;
    if (entity === marine()) {
        fireWeapon();
    } else {
        fireMonsterAttackViaDescriptor(entity);
    }
}

// ============================================================================
// Descriptor builders
// ============================================================================

/**
 * Weapon-damage rolls matching original DOOM formulas.
 *
 * Based on: linuxdoom-1.10/p_pspr.c weapon action functions.
 *   - 'melee':   (P_Random()%10 + 1) * 2, ×10 when Berserk.
 *   - 'hitscan': 5 * (P_Random()%3 + 1).
 *   - 'rocket':  (P_Random()%8 + 1) * 20.
 */
function rollMarineDamage(damageType, attacker) {
    switch (damageType) {
        case 'melee': {
            const base = (Math.floor(Math.random() * 10) + 1) * 2;
            return hasPowerup(attacker, 'berserk') ? base * 10 : base;
        }
        case 'hitscan':
            return 5 * (Math.floor(Math.random() * 3) + 1);
        case 'rocket':
            return (Math.floor(Math.random() * 8) + 1) * 20;
        default:
            return 0;
    }
}

/**
 * Descriptor for a marine-shaped weapon loadout — reads
 * `WEAPONS[attacker.currentWeapon]` and wires in the correct damage roll,
 * spread, projectile template, and sound. Shared by marine-driven fire
 * (user) and marine-as-AI fire (controller).
 */
export function buildMarineAttackDescriptor(attacker, opts = {}) {
    const { aimTarget = null, aimVector = null } = opts;
    const weapon = WEAPONS[attacker.currentWeapon];
    if (!weapon) return null;

    if (weapon.damageType === 'rocket') {
        return {
            kind: 'projectile',
            range: weapon.range,
            damageRoll: () => rollMarineDamage('rocket', attacker),
            projectileTemplate: PLAYER_ROCKET_TEMPLATE,
            sound: weapon.sound,
            isPlayerRocket: true,
            aimTarget,
            aimVector,
        };
    }

    if (weapon.damageType === 'pellets') {
        return {
            kind: 'hitscan',
            range: weapon.range,
            damageRoll: () => rollMarineDamage('hitscan', attacker),
            pelletCount: weapon.pellets,
            spreadDegrees: 22.5,
            sound: weapon.sound,
            aimTarget,
            aimVector,
        };
    }

    return {
        kind: weapon.damageType === 'melee' ? 'melee' : 'hitscan',
        range: weapon.range,
        damageRoll: () => rollMarineDamage(weapon.damageType, attacker),
        sound: weapon.sound,
        drawHitscanPuffs: Boolean(weapon.hitscan),
        aimTarget,
        aimVector,
    };
}

/**
 * Melee-damage roll table for monster claw / bite attacks.
 * Based on: linuxdoom-1.10/p_enemy.c:A_TroopAttack / A_SargAttack / A_BruisAttack.
 */
const MONSTER_MELEE_ROLL = {
    3001: () => (Math.floor(Math.random() * 8) + 1) * 3,  // Imp claw
    3002: () => (Math.floor(Math.random() * 10) + 1) * 4, // Demon bite
    58:   () => (Math.floor(Math.random() * 10) + 1) * 4, // Spectre bite
    3003: () => (Math.floor(Math.random() * 8) + 1) * 10, // Baron claw
};

/**
 * Descriptor for a monster attack, built off `ENEMY_AI_STATS` /
 * `ENEMY_PROJECTILES`. Shared by the autonomous AI path (`controller.js`)
 * and the body-swap path (above). Callers set exactly one of:
 *   - `attackIsMelee: true`          — force melee claw / bite.
 *   - `aimTarget: actor`             — aim a ranged attack at `actor` (AI).
 *   - `aimVector: {x,y}`             — aim a ranged attack along a vector (body-swap).
 */
export function buildMonsterAttackDescriptor(monster, opts = {}) {
    const ai = monster.ai;
    const { attackIsMelee = false, aimTarget = null, aimVector = null } = opts;
    const projectileDef = ENEMY_PROJECTILES[monster.type];

    if (attackIsMelee) {
        const roll = MONSTER_MELEE_ROLL[monster.type] || (() => 0);
        return {
            kind: 'melee',
            range: ai?.meleeRange || 80,
            damageRoll: roll,
            sound: (monster.type === 3002 || monster.type === 58) ? 'DSSGTATK' : 'DSCLAW',
            aimTarget,
            aimVector,
        };
    }

    if (projectileDef) {
        return {
            kind: 'projectile',
            range: ai?.attackRange ?? 2048,
            damageRoll: () => (Math.floor(Math.random() * 8) + 1) * projectileDef.missileDamage,
            projectileTemplate: projectileDef,
            sound: projectileDef.sound,
            aimTarget,
            aimVector,
        };
    }

    // Hitscan fallback (Zombieman / Shotgun Guy).
    return {
        kind: 'hitscan',
        range: ai?.attackRange ?? 1500,
        damageRoll: () => (Math.floor(Math.random() * 5) + 1) * 3,
        pelletCount: ai?.pellets || 1,
        spreadDegrees: 22.5,
        sound: ai?.hitscanSound,
        aimTarget,
        aimVector,
    };
}

/**
 * Body-swap: fire the intrinsic attack of the monster the current session
 * possesses. Aim comes from the monster's view angle (user is looking).
 */
function fireMonsterAttackViaDescriptor(monster) {
    if (!monster || !monster.ai) return;
    const ai = monster.ai;
    const cooldownMs = (ai.cooldown || 1) * 1000;
    const now = performance.now();
    if (now - (ai.lastAttack || 0) < cooldownMs) return;
    ai.lastAttack = now;

    // Flash the monster into its attack sprite. Do NOT touch the marine's
    // `isFiring` flag — that's the marine UI state broadcast to clients.
    setEnemyState(monster, 'attacking');
    setTimeout(() => {
        if (!monster.ai || monster.collected || (monster.hp ?? 0) <= 0) return;
        if (!isHumanControlled(monster)) return;
        setEnemyState(monster, 'chasing');
    }, Math.min(cooldownMs, 350));

    const viewAngle = typeof monster.viewAngle === 'number'
        ? monster.viewAngle
        : (monster.facing ?? 0) - Math.PI / 2;
    const aimVector = { x: -Math.sin(viewAngle), y: Math.cos(viewAngle) };

    // Prefer a melee swing when the possessor is close enough to a live
    // target in the aim cone; otherwise fall back to the monster's ranged
    // attack (projectile or hitscan).
    const meleeRange = ai.meleeRange || 80;
    const meleeHit = (ai.melee || ai.meleeRange)
        ? findAttackableInCone(monster, aimVector.x, aimVector.y, meleeRange)
        : null;
    const attackIsMelee = Boolean(meleeHit);

    performAttack(monster, buildMonsterAttackDescriptor(monster, { attackIsMelee, aimVector }));
    propagateSoundFrom(monster);
}

// ============================================================================
// Projectile spawning (unified for enemy fireballs + player rockets)
// ============================================================================

/**
 * Spawn a projectile for `attacker`. Direction comes from `(forwardX,
 * forwardY)` (already resolved from either `aimTarget` or `aimVector`).
 * For enemies, `aimTarget` is used to compute the initial Z slope so the
 * fireball arcs toward the target's eye height. Player rockets fire flat.
 */
function spawnAttackProjectile(attacker, template, forwardX, forwardY, opts) {
    const { aimTarget, isPlayerRocket, directDamage } = opts;

    const attackerFloor = attacker.floorHeight ?? getFloorHeightAt(attacker.x, attacker.y);
    const spawnZ = attackerFloor + EYE_HEIGHT * 0.8;

    let directionZ = 0;
    let dirX = forwardX;
    let dirY = forwardY;
    if (aimTarget && !isPlayerRocket) {
        const targetFloor = aimTarget.floorHeight ?? getFloorHeightAt(aimTarget.x, aimTarget.y);
        const targetZ = targetFloor + EYE_HEIGHT;
        const deltaZ = targetZ - spawnZ;
        const dist = getTotalDistance(
            { x: attacker.x, y: attacker.y, z: spawnZ },
            { x: aimTarget.x, y: aimTarget.y, z: targetZ },
        );
        const inv = dist > 0 ? 1 / dist : 0;
        dirX = (aimTarget.x - attacker.x) * inv;
        dirY = (aimTarget.y - attacker.y) * inv;
        directionZ = deltaZ * inv;
    }

    const speed = state.skillLevel === 5 ? template.speed * 2 : template.speed;
    const lifetime = 5;
    const projectileId = state.nextProjectileId++;

    renderer.createProjectile(projectileId, {
        type: template.type || 'enemy',
        width: template.size,
        height: template.size,
        sprite: template.sprite,
        x: attacker.x, y: attacker.y, z: spawnZ,
    });

    state.projectiles.push({
        id: projectileId,
        startX: attacker.x,
        startY: attacker.y,
        startZ: spawnZ,
        x: attacker.x,
        y: attacker.y,
        z: spawnZ,
        directionX: dirX,
        directionY: dirY,
        directionZ,
        speed,
        damage: directDamage,
        missileDamage: template.missileDamage,
        hitSound: template.hitSound,
        source: attacker,
        lifetime,
        isPlayerRocket: Boolean(isPlayerRocket),
        spawnTime: performance.now() / 1000,
    });
}

// ============================================================================
// Rocket / barrel radius damage
// ============================================================================

/**
 * Handle a player rocket exploding at `(impactX, impactY)`. Iterates every
 * shootable actor / thing within `ROCKET_SPLASH_DAMAGE` and calls the
 * unified `applyDamage` with the linear-falloff amount. No marine special
 * case — the marine eats splash exactly like any other actor.
 *
 * Based on: linuxdoom-1.10/p_map.c:P_RadiusAttack()
 * Accuracy: Exact — `damage = splashDamage - chebyshev(distance)`.
 */
export function rocketExplosion(impactX, impactY, source = marine()) {
    const impact = { x: impactX, y: impactY };
    forEachRadiusDamageTarget(impact, ROCKET_SPLASH_DAMAGE, (target, damage) => {
        applyDamage(target, damage, source, { kind: 'radius' });
    });
}

// ============================================================================
// Bullet puff
// ============================================================================

/**
 * Spawns a bullet puff (wall/target impact particle) at the given position.
 * The puff is pulled 8 units back toward the marine to prevent z-fighting
 * with the wall surface. The renderer handles animation and cleanup.
 */
function spawnImpactPuff(hitX, hitY, hitFloorHeight) {
    const distanceToPlayer = getHorizontalDistance({ x: hitX, y: hitY }, marine());
    if (distanceToPlayer > 1) {
        const toPlayerX = marine().x - hitX;
        const toPlayerY = marine().y - hitY;
        hitX += (toPlayerX / distanceToPlayer) * 8;
        hitY += (toPlayerY / distanceToPlayer) * 8;
    }
    const isTargetHit = hitFloorHeight !== undefined;
    const floorHeight = isTargetHit ? hitFloorHeight : getFloorHeightAt(hitX, hitY);
    const puffHeight = floorHeight + (isTargetHit ? EYE_HEIGHT * 0.5 : EYE_HEIGHT);
    renderer.createPuff(hitX, puffHeight, hitY);
}
