/**
 * Enemy combat helpers that aren't part of the unified damage/attack pipeline.
 *
 * Attack execution lives in `performAttack()` (see `./weapons.js`); damage
 * routing and barrel explosions live in `./damage.js`. The only enemy-
 * specific helper that survives here is the missile-range heuristic used by
 * the AI controller to decide whether a monster tries a ranged attack this
 * tick.
 */

/**
 * Distance-based attack probability check for ranged enemies.
 *
 * Based on: linuxdoom-1.10/p_enemy.c:P_CheckMissileRange()
 * Accuracy: Approximation — uses the same distance-to-probability curve but
 * without DOOM's fixed-point arithmetic or monster-specific overrides (Vile,
 * Revenant, Cyberdemon, Spider Mastermind).
 *
 * At point-blank range the enemy almost always attacks. At long range (200+
 * map units after subtracting the 64-unit close range buffer), there is a
 * ~78% chance (200/256) the enemy decides NOT to attack this frame.
 * Melee-only enemies skip this check entirely (they always attack in range).
 */
export function checkMissileRange(enemy, distanceToPlayer) {
    let adjustedDistance = distanceToPlayer - 64;
    if (!enemy.ai.melee) adjustedDistance -= 128;
    adjustedDistance = Math.max(0, Math.min(200, adjustedDistance));
    return Math.floor(Math.random() * 256) >= adjustedDistance;
}
