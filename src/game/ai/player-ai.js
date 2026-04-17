/**
 * Player-as-AI tick.
 *
 * When the user is possessing a monster the normal player character stays
 * on the map and runs a lightweight Zombieman-style loop: wake up when it
 * can see a monster, chase it, and fire its currently-equipped weapon as a
 * hitscan attack. Movement is delegated to the shared enemy chase helper.
 *
 * This module owns only the AI tick. Possession ownership (who is
 * controlled right now) lives in `game/possession.js`; install/remove of
 * the `player.ai` block lives there as well.
 */

import {
    ENEMIES,
    ENEMY_RADIUS,
    LINE_OF_SIGHT_CHECK_INTERVAL,
    WEAPONS,
} from '../constants.js';
import { state, player, debug } from '../state.js';
import { hasLineOfSight } from '../physics/line-of-sight.js';
import { getFloorHeightAt } from '../physics/queries.js';
import { moveEnemyToward } from './chase.js';
import { getHorizontalDistance, randomDoomSpreadAngleRadians } from '../geometry.js';
import { damageEnemy } from '../combat/enemy.js';
import { playSound } from '../../audio/audio.js';
import { isHumanControlled, ensurePlayerAi } from '../possession.js';
import { distance2 } from '../actors/math.js';

/**
 * Find the closest living monster (preferring whoever triggered
 * infighting via damage retarget if set). Returns null if no living
 * monsters remain or the player has no AI.
 */
function pickTarget() {
    // Honour an existing damage-induced target if it's still alive.
    const aiTarget = player.ai?.target;
    if (
        aiTarget &&
        typeof aiTarget === 'object' &&
        aiTarget !== player &&
        !aiTarget.collected &&
        (aiTarget.hp ?? 0) > 0
    ) {
        return aiTarget;
    }

    let closestDistSq = Infinity;
    let closest = null;
    const allThings = state.things;
    for (let i = 0; i < allThings.length; i++) {
        const thing = allThings[i];
        if (!thing.ai) continue;
        if (!ENEMIES.has(thing.type)) continue;
        if (thing.collected) continue;
        if ((thing.hp ?? 0) <= 0) continue;
        // Skip the possessed body (we are that actor).
        if (isHumanControlled(thing)) continue;
        const dx = thing.x - player.x;
        const dy = thing.y - player.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < closestDistSq) {
            closestDistSq = d2;
            closest = thing;
        }
    }
    return closest;
}

function rollHitscanDamage() {
    return 5 * (Math.floor(Math.random() * 3) + 1);
}

/**
 * Apply player-AI hitscan damage to the current target. Mirrors the
 * approximation used by `enemyHitscanAttack()` (angular-size hit
 * probability) so the AI is roughly as accurate as a Zombieman.
 */
function fireAiWeapon(target) {
    const weapon = WEAPONS[player.currentWeapon];
    if (!weapon) return;

    if (!hasLineOfSight(player, target)) {
        if (weapon.sound) playSound(weapon.sound);
        return;
    }

    // Consume ammo if the weapon uses any. If out of ammo, skip the shot.
    if (weapon.ammoType) {
        if (player.ammo[weapon.ammoType] < weapon.ammoPerShot) return;
        player.ammo[weapon.ammoType] -= weapon.ammoPerShot;
    }

    const distance = Math.max(1, getHorizontalDistance(player, target));
    const radius = target.ai?.radius ?? ENEMY_RADIUS;
    const angularSize = Math.atan2(radius, distance);

    if (weapon.sound) playSound(weapon.sound);

    const pellets = weapon.pellets || 1;
    let totalDamage = 0;
    for (let i = 0; i < pellets; i++) {
        const spread = randomDoomSpreadAngleRadians(22.5);
        if (Math.abs(spread) < angularSize) {
            totalDamage += rollHitscanDamage();
        }
    }

    if (totalDamage > 0) {
        damageEnemy(target, totalDamage, player);
    }
}

/**
 * Rebind the player's angle to face its current target, so CSS can use
 * `--player-angle` even while the character is AI-driven.
 */
function updatePlayerFacing(target) {
    const dx = target.x - player.x;
    const dy = target.y - player.y;
    if (dx === 0 && dy === 0) return;
    // DOOM angle convention: 0 = north, increasing = counter-clockwise.
    // forwardX = -sin(angle), forwardY = cos(angle)  →  angle = atan2(-dx, dy)
    player.angle = Math.atan2(-dx, dy);
}

/**
 * Tick the player-as-AI. Called every frame from the enemy controller
 * whenever the user is possessing a monster.
 */
export function updatePlayerAi(deltaTime) {
    if (!player.ai) ensurePlayerAi();
    if (player.isDead || player.isAiDead) return;

    player.floorHeight = getFloorHeightAt(player.x, player.y);

    const ai = player.ai;
    ai.stateTime += deltaTime;
    if (ai.threshold > 0) ai.threshold -= deltaTime;

    const target = pickTarget();
    if (!target) {
        ai.state = 'idle';
        return;
    }
    ai.target = target;

    const distSq = distance2(player, target);

    switch (ai.state) {
        case 'idle':
            ai.wakeCheckTimer += deltaTime;
            if (ai.wakeCheckTimer >= LINE_OF_SIGHT_CHECK_INTERVAL) {
                ai.wakeCheckTimer = 0;
                if (
                    distSq < ai.sightRange * ai.sightRange &&
                    hasLineOfSight(player, target)
                ) {
                    ai.state = 'chasing';
                    ai.stateTime = 0;
                    ai.reactionTimer = ai.reactionTime;
                }
            }
            break;

        case 'chasing': {
            updatePlayerFacing(target);
            if (moveEnemyToward(player, target, deltaTime)) {
                // Movement updates handled by chase helper.
            }

            if (ai.reactionTimer > 0) {
                ai.reactionTimer -= deltaTime;
                break;
            }

            const now = performance.now();
            if (now - ai.lastAttack > ai.cooldown * 1000) {
                ai.rangedLosTimer += deltaTime;
                if (
                    ai.rangedLosTimer >= LINE_OF_SIGHT_CHECK_INTERVAL &&
                    distSq < ai.attackRange * ai.attackRange
                ) {
                    ai.rangedLosTimer = 0;
                    if (hasLineOfSight(player, target)) {
                        ai.state = 'attacking';
                        ai.stateTime = 0;
                        ai.damageDealt = false;
                    }
                }
            }
            break;
        }

        case 'attacking': {
            updatePlayerFacing(target);
            if (!ai.damageDealt && ai.stateTime >= ai.attackDuration / 2) {
                ai.damageDealt = true;
                if (!debug.noEnemyAttack) {
                    fireAiWeapon(target);
                }
            }
            if (ai.stateTime >= ai.attackDuration) {
                ai.lastAttack = performance.now();
                ai.state = 'chasing';
                ai.stateTime = 0;
            }
            break;
        }

        case 'pain':
            if (ai.stateTime >= ai.painDuration) {
                ai.state = 'chasing';
                ai.stateTime = 0;
            }
            break;
    }
}
