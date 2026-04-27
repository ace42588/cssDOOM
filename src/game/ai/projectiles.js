/**
 * Projectile movement, collision detection, and explosion effects.
 *
 * Projectiles hit any live actor (marine, monsters, possessed bodies) and
 * any shootable thing. No source-identity branching — the only actor
 * excluded from collision is `projectile.source` itself.
 */

import { state } from '../state.js';
import { getFloorHeightAt } from '../physics/queries.js';
import { rayHitPoint } from '../physics/collision.js';
import { hasLineOfSight } from '../physics/line-of-sight.js';
import { applyDamage } from '../combat/damage.js';
import { playSound } from '../../audio/audio.js';
import { rocketExplosion } from '../combat/weapons.js';
import { getThingDamageRadius, isShootableThing } from '../things/geometry.js';
import * as renderer from '../../renderer/index.js';
import {
    getHorizontalDistance,
    horizontalDistanceSquared,
} from '../geometry.js';

// ============================================================================
// Projectiles
// ============================================================================

/** Collision radius for projectile-vs-actor hit detection (map units). */
const PROJECTILE_HIT_RADIUS = 24;

/**
 * Per-actor hit radius: enemies use their AI radius, barrels their barrel
 * radius, the marine uses the fallback projectile radius.
 */
function actorHitRadius(actor) {
    if (typeof actor.radius === 'number') return actor.radius;
    if (actor.ai?.radius) return actor.ai.radius;
    return PROJECTILE_HIT_RADIUS;
}

/** True if the projectile can damage `entity` right now. */
function isProjectileVictim(entity, projectile) {
    if (!entity) return false;
    if (entity === projectile.source) return false;
    if (entity.collected) return false;
    if (entity.deathMode) return false;
    if ((entity.hp ?? 0) <= 0) return false;
    if (entity.ai || typeof entity.currentWeapon === 'number') return true;
    return isShootableThing(entity);
}

/** Roll impact damage for an enemy projectile: `(P_Random()%8+1) * missileDamage`. */
function rollProjectileDamage(projectile) {
    if (projectile.isPlayerRocket) return projectile.damage || 0;
    return (Math.floor(Math.random() * 8) + 1) * (projectile.missileDamage || 0);
}

/**
 * Advance every active projectile one frame, handling wall / floor / actor
 * collisions and cleanup. Iterates backwards so `splice()` during removal
 * doesn't skip elements.
 */
export function updateProjectiles() {
    const now = performance.now() / 1000;

    for (let index = state.projectiles.length - 1; index >= 0; index--) {
        const projectile = state.projectiles[index];
        const elapsed = now - projectile.spawnTime;

        if (elapsed >= projectile.lifetime) {
            renderer.removeProjectile(projectile.id);
            state.projectiles.splice(index, 1);
            continue;
        }

        const newX = projectile.startX + projectile.directionX * projectile.speed * elapsed;
        const newY = projectile.startY + projectile.directionY * projectile.speed * elapsed;
        const newZ = projectile.startZ + projectile.directionZ * projectile.speed * elapsed;

        // Wall collision: line-of-sight break between old → new position means
        // the projectile hit a wall. Use rayHitPoint to place the explosion
        // against the wall surface (pulled back 25 units to avoid clipping).
        if (!hasLineOfSight(projectile, { x: newX, y: newY })) {
            const moveDist = getHorizontalDistance(projectile, { x: newX, y: newY });
            const dirX = moveDist > 0 ? (newX - projectile.x) / moveDist : 0;
            const dirY = moveDist > 0 ? (newY - projectile.y) / moveDist : 0;
            const hitPoint = rayHitPoint(projectile.x, projectile.y, dirX, dirY, moveDist, projectile.z);
            const impactX = hitPoint ? hitPoint.x - dirX * 25 : projectile.x;
            const impactY = hitPoint ? hitPoint.y - dirY * 25 : projectile.y;
            spawnFireballExplosion(impactX, impactY, projectile.z);
            playSound(projectile.hitSound);
            if (projectile.isPlayerRocket) rocketExplosion(impactX, impactY, projectile.source);
            renderer.removeProjectile(projectile.id);
            state.projectiles.splice(index, 1);
            continue;
        }

        projectile.x = newX;
        projectile.y = newY;
        projectile.z = newZ;

        const floorHeight = getFloorHeightAt(newX, newY);
        if (newZ <= floorHeight) {
            spawnFireballExplosion(newX, newY, floorHeight);
            playSound(projectile.hitSound);
            if (projectile.isPlayerRocket) rocketExplosion(newX, newY, projectile.source);
            renderer.removeProjectile(projectile.id);
            state.projectiles.splice(index, 1);
            continue;
        }

        // Actor / thing collision — iterate every entity that could be hit,
        // excluding the projectile's own source. First live actor / thing
        // inside its combined hit radius takes the projectile. Infighting
        // falls out naturally because the hit sourceActor attribution
        // drives `applyDamage`'s target.ai.threshold retarget logic.
        let struck = null;
        for (let i = 0, count = state.actors.length; i < count && !struck; i++) {
            const actor = state.actors[i];
            if (!isProjectileVictim(actor, projectile)) continue;
            const hitRadius = PROJECTILE_HIT_RADIUS + actorHitRadius(actor);
            if (horizontalDistanceSquared(projectile, actor) < hitRadius * hitRadius) {
                struck = actor;
            }
        }
        if (!struck) {
            for (let i = 0, count = state.things.length; i < count && !struck; i++) {
                const thing = state.things[i];
                if (!isProjectileVictim(thing, projectile)) continue;
                const hitRadius = PROJECTILE_HIT_RADIUS + getThingDamageRadius(thing);
                if (horizontalDistanceSquared(projectile, thing) < hitRadius * hitRadius) {
                    struck = thing;
                }
            }
        }

        if (struck) {
            spawnFireballExplosion(projectile.x, projectile.y, projectile.z);
            playSound(projectile.hitSound);
            applyDamage(struck, rollProjectileDamage(projectile), projectile.source, {
                kind: 'projectile',
            });
            if (projectile.isPlayerRocket) {
                rocketExplosion(projectile.x, projectile.y, projectile.source);
            }
            renderer.removeProjectile(projectile.id);
            state.projectiles.splice(index, 1);
            continue;
        }
    }
}

// ============================================================================
// Fireball Explosion
// ============================================================================

/**
 * Spawns a fireball explosion effect at the given 3D position. This is the
 * visual impact effect when a projectile hits a wall / floor / actor. The
 * renderer handles animation and cleanup.
 */
function spawnFireballExplosion(worldX, worldY, worldZ) {
    renderer.createExplosion(worldX, worldY, worldZ);
}

