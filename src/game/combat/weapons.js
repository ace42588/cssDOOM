/**
 * Player weapon equipping, firing, hit detection, and rocket projectiles.
 */

import { state, getMarine } from '../state.js';

const marine = () => getMarine();
import {
    WEAPONS, SHOOTABLE, EYE_HEIGHT, ENEMIES, ENEMY_PROJECTILES,
    PLAYER_ROCKET_SPEED, PLAYER_ROCKET_RADIUS,
    ROCKET_SPLASH_DAMAGE,
} from '../constants.js';
import { getFloorHeightAt } from '../physics/queries.js';
import { rayHitPoint } from '../physics/collision.js';
import { hasLineOfSight } from '../physics/line-of-sight.js';
import { damageActor } from './damage.js';
import { hasPowerup } from '../actor/pickups.js';
import { playSound } from '../../audio/audio.js';
import { setEnemyState } from '../ai/state.js';
import { damageEnemy } from './enemy.js';
import { forEachRadiusDamageTarget } from './radius.js';
import * as renderer from '../../renderer/index.js';
import { input } from '../../input/index.js';
import { propagateSound } from '../sound-propagation.js';
import { getHorizontalDistance, randomDoomSpreadAngleRadians } from '../geometry.js';
import { distance2 } from '../actors/math.js';
import { markPlayerDirty } from '../services.js';
import { getControlled, isControllingPlayer, isHumanControlled, getControlledFor, LOCAL_SESSION } from '../possession.js';
import { canFire } from '../entity/caps.js';

// ============================================================================
// Weapon Loading & Equipping
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

// ============================================================================
// Firing
// ============================================================================

/**
 * Interval handle for continuous-fire weapons (e.g. chaingun).
 * When a continuous weapon fires, an interval is started that keeps firing
 * rounds at the weapon's fire rate until the player releases the fire button,
 * runs out of ammo, or dies.
 */
let automaticFireInterval = null;

/**
 * Fires the currently equipped weapon. This is the main entry point for all
 * weapon firing logic.
 *
 * Firing mechanics:
 * 1. Checks preconditions: player alive, not already firing, not mid-switch,
 *    weapon exists, and sufficient ammo.
 * 2. Deducts ammo and triggers the fire animation via the renderer.
 * 3. Performs hit detection — hitscan weapons cast instant rays; melee weapons
 *    check a short-range cone; the rocket launcher spawns a projectile.
 * 4. Alerts nearby idle enemies via sound propagation.
 * 5. For continuous-fire weapons (like the chaingun): starts a repeating
 *    setInterval that re-fires automatically as long as the fire button is
 *    held. Each interval tick deducts ammo, plays the fire sound, and runs
 *    hit detection. Non-continuous weapons wait for the renderer to signal
 *    that the fire animation has completed before allowing re-fire.
 */
export function fireWeapon() {
    if (marine().hp <= 0 || marine().deathMode || marine().isFiring || renderer.isWeaponSwitching()) return;

    // Body-swap: if the user is possessing a monster, trigger its built-in
    // attack (melee/hitscan/projectile) instead of the player weapon path.
    if (!isControllingPlayer()) {
        fireMonsterAttack();
        return;
    }

    if (!canFire(marine())) return;
    const weapon = WEAPONS[marine().currentWeapon];
    if (!weapon) return;

    // Deduct ammo cost for this shot
    if (weapon.ammoType) marine().ammo[weapon.ammoType] -= weapon.ammoPerShot;
    markPlayerDirty();
    marine().isFiring = true;

    playSound(weapon.sound);

    renderer.startFiring();

    // Perform hitscan hit detection for this shot
    checkWeaponHit();

    // Wake up nearby idle enemies who can hear the gunfire
    alertNearbyEnemies();

    // Continuous-fire weapons (chaingun): set up an auto-fire interval that
    // keeps shooting at the weapon's fire rate while the fire button is held.
    // Each interval tick deducts ammo, plays the fire sound, and runs hit detection.
    if (weapon.continuous && input.fireHeld) {
        stopAutoFire();
        automaticFireInterval = setInterval(() => {
            if (!input.fireHeld || marine().hp <= 0 || marine().deathMode || (weapon.ammoType && marine().ammo[weapon.ammoType] < weapon.ammoPerShot)) {
                stopAutoFire();
                return;
            }
            if (weapon.ammoType) marine().ammo[weapon.ammoType] -= weapon.ammoPerShot;
            markPlayerDirty();
            playSound(weapon.sound);
            checkWeaponHit();
            alertNearbyEnemies();
        }, weapon.fireRate);
    } else {
        // Non-continuous weapons: re-allow firing after the fire rate elapses.
        // If the fire button is still held, immediately fire again.
        setTimeout(() => {
            marine().isFiring = false;
            if (input.fireHeld) fireWeapon();
        }, weapon.fireRate);
    }
}

/**
 * Stops the continuous-fire interval (used by chaingun). Called when the
 * player releases the fire button, runs out of ammo, or dies.
 */
export function stopAutoFire() {
    if (automaticFireInterval) {
        clearInterval(automaticFireInterval);
        automaticFireInterval = null;
        renderer.stopFiring();
        marine().isFiring = false;
    }
}

// ============================================================================
// Sound Alert — enemies hear gunfire and wake up
// ============================================================================

/**
 * When the player fires a weapon, propagate sound through connected sectors.
 * Enemies in reached sectors will wake up during their next AI idle check.
 *
 * Based on: linuxdoom-1.10/p_enemy.c:P_NoiseAlert() → P_RecursiveSound()
 * Sound floods through two-sided linedefs, blocked by ML_SOUNDBLOCK lines
 * (can pass through at most one sound-blocking line).
 */
function alertNearbyEnemies() {
    propagateSound();
}

// ============================================================================
// Weapon Damage Rolls
// ============================================================================

/**
 * Rolls random weapon damage matching original DOOM formulas.
 *
 * Based on: linuxdoom-1.10/p_pspr.c weapon action functions
 * Accuracy: Exact — same random multiplier ranges and formulas.
 *
 * 'melee':   (P_Random()%10 + 1) * 2 = 2-20 damage.
 *            Based on: A_Punch() / A_Saw() — p_pspr.c lines ~120, ~170
 * 'hitscan': 5 * (P_Random()%3 + 1) = 5, 10, or 15 damage.
 *            Based on: P_GunShot() — p_map.c line ~800
 * 'rocket':  (P_Random()%8 + 1) * 20 = 20-160 direct hit damage.
 *            Based on: A_FireMissile() / P_DamageMobj() — p_pspr.c, p_inter.c
 */
function rollWeaponDamage(damageType) {
    switch (damageType) {
        case 'melee': {
            // Based on: linuxdoom-1.10/p_map.c:P_LineAttack() — Berserk multiplies by 10
            const baseDamage = (Math.floor(Math.random() * 10) + 1) * 2;
            return hasPowerup('berserk') ? baseDamage * 10 : baseDamage;
        }
        case 'hitscan':
            return 5 * (Math.floor(Math.random() * 3) + 1);
        case 'rocket':
            return (Math.floor(Math.random() * 8) + 1) * 20;
        default:
            return 0;
    }
}

// ============================================================================
// Player Hit Detection
// ============================================================================

/**
 * Finds the closest shootable thing along a ray from the player's position.
 * Used by hitscan weapons (pistol, shotgun, chaingun) and melee weapons.
 *
 * The ray is defined by a direction vector (dirX, dirY) and a maximum range.
 * A dot product threshold of 0.99 (~8° cone) determines if a thing is close
 * enough to the ray to be considered a hit.
 */
function findHitscanTarget(dirX, dirY, range) {
    let closestDistance = Infinity;
    let closestThing = null;

    for (let index = 1, length = state.actors.length; index < length; index++) {
        const thing = state.actors[index];
        if (!thing || thing.collected) continue;
        if (!SHOOTABLE.has(thing.type)) continue;

        const deltaX = thing.x - marine().x;
        const deltaY = thing.y - marine().y;
        const distance = Math.sqrt(distance2(marine(), thing));
        if (distance > range) continue;

        const dotProduct = (deltaX * dirX + deltaY * dirY) / distance;
        if (dotProduct < 0.99) continue;

        if (distance < closestDistance) {
            closestDistance = distance;
            closestThing = thing;
        }
    }
    for (let index = 0, length = state.things.length; index < length; index++) {
        const thing = state.things[index];
        if (!thing || thing.collected) continue;
        if (!SHOOTABLE.has(thing.type)) continue;

        const deltaX = thing.x - marine().x;
        const deltaY = thing.y - marine().y;
        const distance = Math.sqrt(distance2(marine(), thing));
        if (distance > range) continue;

        const dotProduct = (deltaX * dirX + deltaY * dirY) / distance;
        if (dotProduct < 0.99) continue;

        if (distance < closestDistance) {
            closestDistance = distance;
            closestThing = thing;
        }
    }

    return closestThing;
}

/**
 * Performs weapon hit detection and damage for the current weapon shot.
 *
 * Weapon types handled:
 * - 'melee' (Fist, Chainsaw): Short-range cone check, random 2-20 damage.
 * - 'hitscan' (Pistol, Chaingun): Single ray, random 5/10/15 damage.
 * - 'pellets' (Shotgun): 7 rays with angular spread, each doing 5/10/15 damage.
 *   Based on: linuxdoom-1.10/p_pspr.c:A_FireShotgun() — 7 bullets with
 *   P_GunShot(mo, false) which applies horizontal spread.
 *   Accuracy: Approximation — uses ±22.5° spread per pellet (matching DOOM's
 *   (P_Random()-P_Random())<<18 in a 32-bit angle space ≈ ±22.4° max).
 * - 'rocket' (Rocket Launcher): Spawns a player projectile instead of hitscan.
 */
function checkWeaponHit() {
    const weapon = WEAPONS[marine().currentWeapon];
    if (!weapon) return;

    const forwardX = -Math.sin(marine().viewAngle);
    const forwardY = Math.cos(marine().viewAngle);

    if (weapon.damageType === 'rocket') {
        // Rocket launcher spawns a projectile instead of hitscan
        spawnPlayerRocket(forwardX, forwardY);
        return;
    }

    if (weapon.damageType === 'pellets') {
        // Shotgun: 7 individual pellets, each with angular spread
        // Based on: linuxdoom-1.10/p_pspr.c:A_FireShotgun() calls P_GunShot(mo, false)
        // which applies (P_Random()-P_Random())<<18 spread ≈ ±22.5° max per pellet.
        // Accuracy: Approximation — we use ±22.5° triangular spread via
        // (random - random) to approximate DOOM's (P_Random()-P_Random()).
        for (let pellet = 0; pellet < weapon.pellets; pellet++) {
            const spreadAngle = randomDoomSpreadAngleRadians(22.5);
            const pelletAngle = marine().viewAngle + spreadAngle;
            const pelletDirX = -Math.sin(pelletAngle);
            const pelletDirY = Math.cos(pelletAngle);

            const target = findHitscanTarget(pelletDirX, pelletDirY, weapon.range);
            if (target && hasLineOfSight(marine(), target)) {
                spawnPuff(target.x, target.y, getFloorHeightAt(target.x, target.y));
                damageEnemy(target, rollWeaponDamage('hitscan'), marine());
            } else {
                const wallHit = rayHitPoint(marine().x, marine().y, pelletDirX, pelletDirY, weapon.range);
                if (wallHit) spawnPuff(wallHit.x, wallHit.y);
            }
        }
        return;
    }

    // Melee and single-ray hitscan weapons
    const target = findHitscanTarget(forwardX, forwardY, weapon.range);

    if (target && hasLineOfSight(marine(), target)) {
        if (weapon.hitscan) spawnPuff(target.x, target.y, getFloorHeightAt(target.x, target.y));
        damageEnemy(target, rollWeaponDamage(weapon.damageType), marine());
        return;
    }

    // No target or target behind a wall — spawn wall puff
    if (weapon.hitscan) {
        const wallHitPoint = rayHitPoint(marine().x, marine().y, forwardX, forwardY, weapon.range);
        if (wallHitPoint) spawnPuff(wallHitPoint.x, wallHitPoint.y);
    }
}

// ============================================================================
// Player Rocket Projectile
// ============================================================================

/**
 * Spawns a player-fired rocket projectile. The rocket travels in the player's
 * facing direction and explodes on contact with a wall or enemy, dealing
 * direct hit damage plus splash damage in a radius.
 *
 * Based on: linuxdoom-1.10/p_pspr.c:A_FireMissile() and info.c:mobjinfo[MT_ROCKET]
 * Accuracy: Approximation — uses the same speed, radius, and damage values but
 * the projectile physics use our simplified per-frame movement rather than DOOM's
 * fixed-point P_MobjThinker().
 */
function spawnPlayerRocket(forwardX, forwardY) {
    const spawnX = marine().x;
    const spawnY = marine().y;
    const spawnZ = marine().floorHeight + EYE_HEIGHT * 0.8;

    const lifetime = 5;

    const projectileId = state.nextProjectileId++;
    renderer.createProjectile(projectileId, {
        type: 'player-rocket',
        width: 11, height: 11, sprite: 'MISLA1',
        x: spawnX, y: spawnY, z: spawnZ,
    });

    state.projectiles.push({
        id: projectileId,
        startX: spawnX,
        startY: spawnY,
        startZ: spawnZ,
        x: spawnX,
        y: spawnY,
        z: spawnZ,
        directionX: forwardX,
        directionY: forwardY,
        directionZ: 0,
        speed: PLAYER_ROCKET_SPEED,
        damage: rollWeaponDamage('rocket'),
        hitSound: 'DSBAREXP',
        source: marine(),
        lifetime,
        isPlayerRocket: true,
        spawnTime: performance.now() / 1000,
    });
}

/**
 * Handles a player rocket explosion at a given position. Deals splash damage
 * to all shootable things and the player within ROCKET_SPLASH_RADIUS.
 * Damage falls off linearly with distance from the impact point.
 *
 * Based on: linuxdoom-1.10/p_map.c:P_RadiusAttack()
 * Accuracy: Exact — uses DOOM's subtractive falloff: damage = splashDamage - dist.
 */
export function rocketExplosion(impactX, impactY) {
    const impact = { x: impactX, y: impactY };
    forEachRadiusDamageTarget(impact, ROCKET_SPLASH_DAMAGE, (target, damage) => {
        if (target === marine()) {
            damageActor(marine(), damage, null);
            return;
        }
        damageEnemy(target, damage, marine());
    });
}

// ============================================================================
// Bullet Puff
// ============================================================================

/**
 * Spawns a bullet puff (wall/target impact particle) at the given position.
 * The puff is pulled 8 units back toward the player to prevent z-fighting
 * with the wall surface. The renderer handles animation and cleanup.
 */
function spawnPuff(hitX, hitY, hitFloorHeight) {
    // Pull back 8 units toward the player so the puff doesn't clip into the wall
    const distanceToPlayer = getHorizontalDistance({ x: hitX, y: hitY }, marine());
    if (distanceToPlayer > 1) {
        const toPlayerX = marine().x - hitX;
        const toPlayerY = marine().y - hitY;
        hitX += (toPlayerX / distanceToPlayer) * 8;
        hitY += (toPlayerY / distanceToPlayer) * 8;
    }
    // Target hits use the provided floor height + half eye height (chest level);
    // wall hits sample the floor at the pulled-back position + full eye height
    const isTargetHit = hitFloorHeight !== undefined;
    const floorHeight = isTargetHit ? hitFloorHeight : getFloorHeightAt(hitX, hitY);
    const puffHeight = floorHeight + (isTargetHit ? EYE_HEIGHT * 0.5 : EYE_HEIGHT);
    renderer.createPuff(hitX, puffHeight, hitY);
}

// ============================================================================
// Monster attack (body-swap)
// ============================================================================

/**
 * Fire the built-in attack of the currently-possessed monster. The user is
 * driving the monster, so attacks are aimed in the direction the camera is
 * facing (derived from the monster's `viewAngle`).
 *
 * Three attack types are supported, matching the enemy AI:
 *   - melee: Demon/Spectre-style short-range bite (any shootable in the
 *     front cone within meleeRange takes damage).
 *   - projectile: Imp/Baron fireball — spawns the projectile with a synthetic
 *     target far in the aim direction so the existing spawnProjectile path
 *     can build the direction vector.
 *   - hitscan: Zombieman/Shotgun Guy — picks the closest shootable within
 *     the firing cone and rolls pellet damage.
 */
/**
 * Server entry point: fire the weapon of whichever body session `sessionId`
 * controls. Routes to the marine weapon path if the session holds the
 * marine, or to the possessed-monster attack otherwise.
 */
export function fireWeaponFor(sessionId) {
    const entity = getControlledFor(sessionId);
    if (!entity) return;
    if (!canFire(entity)) return;
    if (entity === marine()) {
        fireWeapon();
    } else {
        fireMonsterAttack(entity);
    }
}

function fireMonsterAttack(explicitMonster) {
    const monster = explicitMonster || getControlled();
    if (!monster || !monster.ai) return;

    const cooldownMs = (monster.ai.cooldown || 1) * 1000;
    const now = performance.now();
    if (now - (monster.ai.lastAttack || 0) < cooldownMs) return;
    monster.ai.lastAttack = now;
    // Briefly flash the monster into its attack sprite. We deliberately
    // do NOT touch `marine().isFiring` here — that flag is the marine's UI
    // state and is broadcast to every client via snapshots; mutating it
    // from a possessed-monster attack would flicker the marine HUD and
    // (when a stale setTimeout fires after the monster has died or been
    // released) clobber a real fire-in-progress on the marine.
    setEnemyState(monster, 'attacking');
    setTimeout(() => {
        // Guard against the monster having been killed, collected, or
        // released between scheduling and firing — `setEnemyState` would
        // otherwise rewrite a freed AI block.
        if (!monster.ai || monster.collected || (monster.hp ?? 0) <= 0) return;
        if (!isHumanControlled(monster)) return;
        setEnemyState(monster, 'chasing');
    }, Math.min(cooldownMs, 350));

    const viewAngle = typeof monster.viewAngle === 'number'
        ? monster.viewAngle
        : (monster.facing ?? 0) - Math.PI / 2;
    const forwardX = -Math.sin(viewAngle);
    const forwardY = Math.cos(viewAngle);

    if (monster.ai.melee || monster.ai.meleeRange) {
        const meleeRange = monster.ai.meleeRange || 80;
        const meleeTarget = findShootableInCone(monster, forwardX, forwardY, meleeRange);
        if (meleeTarget) {
            const rng = Math.floor(Math.random() * 10) + 1;
            const damage = monster.type === 3003 ? rng * 10 : rng * 4;
            if (hasLineOfSight(monster, meleeTarget)) {
                applyMonsterDamage(meleeTarget, damage, monster);
            }
            playSound(
                monster.type === 3002 || monster.type === 58 ? 'DSSGTATK' : 'DSCLAW',
            );
        }
        // If the monster also has a ranged attack, fall through only if no
        // melee target was hit. Pure melee monsters stop here.
        if (meleeTarget || monster.type === 3002 || monster.type === 58) return;
    }

    const projectileDef = ENEMY_PROJECTILES[monster.type];
    if (projectileDef) {
        spawnPossessedProjectile(monster, projectileDef, forwardX, forwardY);
        return;
    }

    // Hitscan fallback (Zombieman/Shotgun Guy)
    const pellets = monster.ai.pellets || 1;
    if (monster.ai.hitscanSound) playSound(monster.ai.hitscanSound);
    const target = findShootableInCone(monster, forwardX, forwardY, monster.ai.attackRange || 1500);
    for (let i = 0; i < pellets; i++) {
        const spread = randomDoomSpreadAngleRadians(22.5);
        const sx = -Math.sin(viewAngle + spread);
        const sy = Math.cos(viewAngle + spread);
        const rayTarget = findShootableInCone(monster, sx, sy, monster.ai.attackRange || 1500);
        const chosen = rayTarget || target;
        if (chosen && hasLineOfSight(monster, chosen)) {
            const damage = (Math.floor(Math.random() * 5) + 1) * 3;
            applyMonsterDamage(chosen, damage, monster);
            renderer.createPuff(chosen.x, getFloorHeightAt(chosen.x, chosen.y) + EYE_HEIGHT * 0.5, chosen.y);
        } else {
            const wallHit = rayHitPoint(monster.x, monster.y, sx, sy, monster.ai.attackRange || 1500);
            if (wallHit) renderer.createPuff(wallHit.x, getFloorHeightAt(wallHit.x, wallHit.y) + EYE_HEIGHT, wallHit.y);
        }
    }
    propagateSound();
}

/**
 * Spawn a projectile from the possessed monster aimed in the look direction.
 * Mirrors the geometry of `ai/projectiles.js:spawnProjectile()` but takes a
 * forward vector directly so we avoid routing through `ai.target` (and sidestep
 * the circular import that would pull spawnProjectile into this module).
 */
function spawnPossessedProjectile(monster, projectileDef, forwardX, forwardY) {
    const floorHeight = getFloorHeightAt(monster.x, monster.y);
    const spawnHeight = floorHeight + EYE_HEIGHT * 0.8;

    const speed = state.skillLevel === 5 ? projectileDef.speed * 2 : projectileDef.speed;
    const lifetime = 5;

    const projectileId = state.nextProjectileId++;
    renderer.createProjectile(projectileId, {
        type: 'enemy',
        width: projectileDef.size, height: projectileDef.size,
        sprite: projectileDef.sprite,
        x: monster.x, y: monster.y, z: spawnHeight,
    });

    state.projectiles.push({
        id: projectileId,
        startX: monster.x,
        startY: monster.y,
        startZ: spawnHeight,
        x: monster.x,
        y: monster.y,
        z: spawnHeight,
        directionX: forwardX,
        directionY: forwardY,
        directionZ: 0,
        speed,
        missileDamage: projectileDef.missileDamage,
        hitSound: projectileDef.hitSound,
        source: monster,
        lifetime,
        spawnTime: performance.now() / 1000,
    });
    playSound(projectileDef.sound);
}

/**
 * Find the closest damageable thing / player within a forward cone. Used
 * by the possessed monster's attacks — the user aims by looking.
 */
function findShootableInCone(source, dirX, dirY, range) {
    let closestDistance = Infinity;
    let closest = null;

    for (let i = 1; i < state.actors.length; i++) {
        const thing = state.actors[i];
        if (!thing || thing === source) continue;
        if (thing.collected) continue;
        if (!SHOOTABLE.has(thing.type)) continue;
        const dx = thing.x - source.x;
        const dy = thing.y - source.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d === 0 || d > range) continue;
        const dot = (dx * dirX + dy * dirY) / d;
        if (dot < 0.92) continue;
        if (d < closestDistance) {
            closestDistance = d;
            closest = thing;
        }
    }
    for (let i = 0; i < state.things.length; i++) {
        const thing = state.things[i];
        if (!thing || thing === source) continue;
        if (thing.collected) continue;
        if (!SHOOTABLE.has(thing.type)) continue;
        const dx = thing.x - source.x;
        const dy = thing.y - source.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d === 0 || d > range) continue;
        const dot = (dx * dirX + dy * dirY) / d;
        if (dot < 0.92) continue;
        if (d < closestDistance) {
            closestDistance = d;
            closest = thing;
        }
    }

    if (marine().hp > 0 && !marine().deathMode && marine() !== source) {
        const dx = marine().x - source.x;
        const dy = marine().y - source.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > 0 && d <= range) {
            const dot = (dx * dirX + dy * dirY) / d;
            if (dot >= 0.92 && d < closestDistance) {
                closestDistance = d;
                closest = marine();
            }
        }
    }

    return closest;
}

function applyMonsterDamage(target, damage, source) {
    if (target === marine()) {
        damageActor(marine(), damage, null);
        return;
    }
    damageEnemy(target, damage, source);
}
