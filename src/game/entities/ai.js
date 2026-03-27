/**
 * Enemy AI — state machine, movement, and per-frame update loop.
 */

import {
    ENEMIES, ENEMY_PROJECTILES,
    MELEE_RANGE, LINE_OF_SIGHT_CHECK_INTERVAL, MAX_RENDER_DISTANCE,
    MAX_STEP_HEIGHT, ENEMY_RADIUS,
} from '../constants.js';

import { state, debug } from '../state.js';
import { canMoveTo, getFloorHeightAt, getSectorLightAt } from '../physics.js';
import * as renderer from '../../renderer/index.js';
import { hasLineOfSight } from '../line-of-sight.js';
import { damagePlayer } from '../player/damage.js';
import { playSound } from '../../audio/audio.js';
import { setEnemyState, respawnEnemy } from './enemies.js';
import { enemyHitscanAttack, enemyHitscanAttackEnemy, checkMissileRange, damageEnemy } from './combat.js';
import { spawnProjectile } from './projectiles.js';

// ============================================================================
// Enemy AI
// ============================================================================

/**
 * Timestamp of the last enemy alert sound, used to throttle alert sounds so
 * multiple enemies waking up simultaneously don't stack their alert cries.
 */
let lastAlertSoundTime = 0;

// 8 cardinal/diagonal directions for DOOM-style grid-aligned movement
const DIRECTION_ANGLES = [0, Math.PI/4, Math.PI/2, 3*Math.PI/4, Math.PI, -3*Math.PI/4, -Math.PI/2, -Math.PI/4];

/**
 * Picks a DOOM-style movement direction for an enemy. Finds the closest
 * cardinal/diagonal direction toward the target, then randomly offsets by
 * one step (45 degrees) to create zig-zag movement patterns similar to
 * the original DOOM AI. Prevents selecting the exact opposite of the
 * previous direction (turnaround prevention).
 *
 * Based on: linuxdoom-1.10/p_enemy.c:P_NewChaseDir()
 * Accuracy: Approximation — prevents turnaround like DOOM, but uses
 * simplified direction selection instead of DOOM's exact try-order logic.
 */
function pickMoveDirection(enemy, targetX, targetY) {
    const deltaX = targetX - enemy.x;
    const deltaY = targetY - enemy.y;
    const angleToTarget = Math.atan2(deltaY, deltaX);

    // Find the closest of 8 cardinal/diagonal directions to the target angle
    let bestDirectionIndex = 0;
    let bestAngleDifference = Infinity;
    for (let directionIndex = 0; directionIndex < 8; directionIndex++) {
        let angleDifference = Math.abs(angleToTarget - DIRECTION_ANGLES[directionIndex]);
        if (angleDifference > Math.PI) angleDifference = Math.PI * 2 - angleDifference;
        if (angleDifference < bestAngleDifference) { bestAngleDifference = angleDifference; bestDirectionIndex = directionIndex; }
    }

    // Randomly offset by +/-1 direction slot to create zig-zag movement
    const randomOffset = Math.random() < 0.5 ? 0 : (Math.random() < 0.5 ? 1 : -1);
    let chosenIndex = (bestDirectionIndex + randomOffset + 8) % 8;

    // Turnaround prevention: if the chosen direction is the exact opposite of
    // the previous direction, pick the best direction without offset instead.
    // Based on: linuxdoom-1.10/p_enemy.c:P_NewChaseDir() — turnaround = opposite
    if (enemy.ai.lastMoveDir !== undefined) {
        const oppositeIndex = (enemy.ai.lastMoveDir + 4) % 8;
        if (chosenIndex === oppositeIndex) {
            chosenIndex = bestDirectionIndex;
        }
    }
    enemy.ai.lastMoveDir = chosenIndex;

    return DIRECTION_ANGLES[chosenIndex];
}

/**
 * Moves an enemy toward a target position using DOOM-style cardinal movement.
 * The enemy periodically picks a new movement direction (every 0.5-1 seconds)
 * and tries to move along it. If blocked by a wall, it tries sliding along
 * just the X or Y axis. If fully blocked, it forces a direction re-evaluation
 * on the next frame.
 */
function moveEnemyToward(enemy, targetX, targetY, deltaTime) {
    if (debug.noEnemyMove) return;
    const deltaX = targetX - enemy.x;
    const deltaY = targetY - enemy.y;
    const distSqToTarget = deltaX * deltaX + deltaY * deltaY;
    if (distSqToTarget <= MELEE_RANGE * MELEE_RANGE) return;

    // Pick a new movement direction periodically (every 0.5-1 seconds)
    enemy.ai.moveTimer = (enemy.ai.moveTimer || 0) - deltaTime;
    if (enemy.ai.moveTimer <= 0 || enemy.ai.moveDir === undefined) {
        enemy.ai.moveDir = pickMoveDirection(enemy, targetX, targetY);
        enemy.ai.moveTimer = 0.5 + Math.random() * 0.5; // re-evaluate every 0.5-1s
    }

    const movementStep = enemy.ai.speed * deltaTime;
    const movementX = Math.cos(enemy.ai.moveDir) * movementStep;
    const movementY = Math.sin(enemy.ai.moveDir) * movementStep;

    let newX = enemy.x + movementX;
    let newY = enemy.y + movementY;
    const previousX = enemy.x;
    const previousY = enemy.y;
    const enemyFloorHeight = getFloorHeightAt(enemy.x, enemy.y);

    // Try full diagonal move first, then axis-aligned sliding, then give up
    if (canMoveTo(newX, newY, ENEMY_RADIUS, enemyFloorHeight, MAX_STEP_HEIGHT)) {
        enemy.x = newX;
        enemy.y = newY;
    } else if (canMoveTo(newX, enemy.y, ENEMY_RADIUS, enemyFloorHeight, MAX_STEP_HEIGHT)) {
        enemy.x = newX;
    } else if (canMoveTo(enemy.x, newY, ENEMY_RADIUS, enemyFloorHeight, MAX_STEP_HEIGHT)) {
        enemy.y = newY;
    } else {
        // Fully blocked — force direction re-evaluation next frame
        enemy.ai.moveTimer = 0;
    }

    // Update the enemy's facing direction based on actual movement vector
    const actualMovementX = enemy.x - previousX;
    const actualMovementY = enemy.y - previousY;
    if (actualMovementX * actualMovementX + actualMovementY * actualMovementY > 0.001) {
        enemy.facing = Math.atan2(actualMovementY, actualMovementX);
    }
}

/**
 * Updates an enemy's rendered position and lighting to match its current
 * world coordinates. Notifies the renderer to update the visual representation.
 */
function updateEnemyPosition(thingIndex, enemy) {
    const floorHeight = getFloorHeightAt(enemy.x, enemy.y);
    renderer.updateThingPosition(thingIndex, enemy.x, enemy.y, floorHeight);
    // Only update lighting periodically — sector light doesn't change often
    if (!enemy._lastLightUpdate || performance.now() - enemy._lastLightUpdate > 1000) {
        enemy._lastLightUpdate = performance.now();
        const sectorLight = getSectorLightAt(enemy.x, enemy.y);
        renderer.updateThingLight(thingIndex, sectorLight);
    }
}

/**
 * Resolves the current chase target's position. Returns {x, y} for wherever
 * the enemy should move toward and attack. If the target is 'player', uses
 * the player's position. If the target is another enemy entry, uses that
 * enemy's position.
 *
 * Also handles target invalidation: if the target enemy is dead/collected,
 * reverts to targeting the player and resets threshold.
 *
 * Based on: linuxdoom-1.10/p_enemy.c:A_Chase() lines ~470-490
 * Accuracy: Exact — same "target dead → threshold=0 → P_LookForPlayers" flow,
 * except P_LookForPlayers always finds the single player in our single-player game.
 */
function resolveTarget(enemy, deltaTime) {
    const enemyAI = enemy.ai;

    if (enemyAI.target !== 'player') {
        // Infighting target — check if it's still alive
        if (enemyAI.target.collected || enemyAI.target.hp <= 0) {
            // Target killed: revert to chasing the player
            enemyAI.target = 'player';
            enemyAI.threshold = 0;
        }
    }

    // Count down the retarget lock timer (in seconds, frame-rate independent)
    if (enemyAI.threshold > 0) {
        enemyAI.threshold -= deltaTime;
    }

    if (enemyAI.target === 'player') {
        return { x: state.playerX, y: state.playerY };
    }
    return { x: enemyAI.target.x, y: enemyAI.target.y };
}

/**
 * Updates a single enemy's AI behavior for one frame.
 *
 * @param {number} thingIndex - Index into state.things
 * @param {object} enemy - The enemy game object
 * @param {number} deltaTime - Frame delta in seconds
 * @param {number} currentTime - Current time from performance.now()
 */
function updateSingleEnemy(thingIndex, enemy, deltaTime, currentTime) {
    const enemyAI = enemy.ai;
    enemyAI.stateTime += deltaTime;

    // Resolve who the enemy is targeting (player or another enemy via infighting)
    const targetPos = resolveTarget(enemy, deltaTime);
    const deltaX = targetPos.x - enemy.x;
    const deltaY = targetPos.y - enemy.y;
    const distSqToTarget = deltaX * deltaX + deltaY * deltaY;

    switch (enemyAI.state) {
        case 'idle':
            // Periodically check if the player is visible (throttled to save performance)
            enemyAI.losTimer += deltaTime;
            if (enemyAI.losTimer >= LINE_OF_SIGHT_CHECK_INTERVAL) {
                enemyAI.losTimer = 0;
                if (distSqToTarget < enemyAI.sightRange * enemyAI.sightRange && hasLineOfSight(enemy.x, enemy.y, targetPos.x, targetPos.y)) {
                    setEnemyState(thingIndex, enemy, 'chasing');
                    // Reaction time: delay before the enemy can first attack after
                    // spotting the player. Based on: linuxdoom-1.10/p_enemy.c:A_Chase()
                    // which checks reactiontime > 0 before allowing missile attacks.
                    enemyAI.reactionTimer = enemyAI.reactionTime;
                    // Throttle alert sounds so multiple enemies waking up at once
                    // don't produce a cacophony of overlapping cries
                    if (currentTime - lastAlertSoundTime > 500) {
                        lastAlertSoundTime = currentTime;
                        playSound(enemyAI.alertSound);
                    }
                }
            }
            break;

        case 'chasing':
            moveEnemyToward(enemy, targetPos.x, targetPos.y, deltaTime);
            updateEnemyPosition(thingIndex, enemy);

            // Count down reaction time (delay before first attack after sighting)
            if (enemyAI.reactionTimer > 0) {
                enemyAI.reactionTimer -= deltaTime;
                break;
            }

            // Check if enemy is close enough and attack cooldown has elapsed
            if (distSqToTarget < enemyAI.attackRange * enemyAI.attackRange && (currentTime - enemyAI.lastAttack) > enemyAI.cooldown * 1000) {
                // Debug: skip attacks against the player
                if (debug.noEnemyAttack && enemyAI.target === 'player') break;
                // Melee enemies always attack in range; ranged enemies need LOS and
                // must pass the distance-based probability check (P_CheckMissileRange)
                if (enemyAI.melee) {
                    setEnemyState(thingIndex, enemy, 'attacking');
                } else {
                    // Throttle LOS checks for ranged attack decisions
                    enemyAI.losTimer += deltaTime;
                    if (enemyAI.losTimer >= LINE_OF_SIGHT_CHECK_INTERVAL) {
                        enemyAI.losTimer = 0;
                        if (hasLineOfSight(enemy.x, enemy.y, targetPos.x, targetPos.y)
                            && checkMissileRange(enemy, Math.sqrt(distSqToTarget))) {
                            setEnemyState(thingIndex, enemy, 'attacking');
                        }
                    }
                }
            }
            break;

        case 'attacking':
            // Damage is dealt at the midpoint of the attack animation, giving
            // the visual wind-up time before the actual hit/shot connects
            if (!enemyAI.damageDealt && enemyAI.stateTime >= enemyAI.attackDuration / 2) {
                enemyAI.damageDealt = true;
                const targetIsPlayer = enemyAI.target === 'player';

                if (enemyAI.melee) {
                    // Melee attack (e.g. Demon bite): direct damage if target is in LOS
                    if (hasLineOfSight(enemy.x, enemy.y, targetPos.x, targetPos.y)) {
                        if (targetIsPlayer) {
                            damagePlayer(enemyAI.damage);
                        } else {
                            damageEnemy(enemyAI.target, enemyAI.damage, enemy);
                        }
                    }
                    playSound('DSSGTATK');
                } else {
                    // Ranged attack: either spawn a projectile or use hitscan
                    const projectileDefinition = ENEMY_PROJECTILES[enemy.type];
                    if (projectileDefinition) {
                        // Projectile enemies (Imp, Cacodemon, Baron): spawn a fireball
                        // toward the current target (player or infighting enemy)
                        spawnProjectile(enemy, projectileDefinition);
                    } else if (enemyAI.pellets) {
                        // Hitscan enemies (Zombieman, Shotgun Guy)
                        if (targetIsPlayer) {
                            enemyHitscanAttack(enemy, enemyAI);
                        } else {
                            // Hitscan against another enemy during infighting
                            enemyHitscanAttackEnemy(enemy, enemyAI);
                        }
                    }
                }
            }
            // Return to chasing after the full attack animation completes
            if (enemyAI.stateTime >= enemyAI.attackDuration) {
                enemyAI.lastAttack = currentTime;
                setEnemyState(thingIndex, enemy, 'chasing');
            }
            break;

        case 'pain':
            // Wait for the pain stun duration to expire before resuming chase
            if (enemyAI.stateTime >= enemyAI.painDuration) {
                setEnemyState(thingIndex, enemy, 'chasing');
            }
            break;
    }
}

/**
 * Main per-frame update for all enemies. Iterates all thing elements, skipping
 * dead/collected things, non-enemies, and enemies beyond the maximum render
 * distance (performance optimization — distant enemies are not visible and
 * don't need AI updates). For each active nearby enemy, runs AI state updates
 * and sprite rotation calculations.
 */
export function updateAllEnemies(deltaTime) {
    if (state.isDead) return;
    const currentTime = performance.now();
    const allThings = state.things;
    for (let index = 0, length = allThings.length; index < length; index++) {
        const thing = allThings[index];
        if (!thing.ai) continue;
        if (!ENEMIES.has(thing.type)) continue;

        // Nightmare respawn: count down dead enemies and respawn them
        // Based on: linuxdoom-1.10/p_mobj.c:P_NightmareRespawn()
        if (thing.collected) {
            if (thing.respawnTimer !== undefined) {
                thing.respawnTimer -= deltaTime;
                if (thing.respawnTimer <= 0) {
                    respawnEnemy(index, thing);
                }
            }
            continue;
        }

        // Skip enemies too far away for performance (they won't be visible anyway)
        const deltaX = thing.x - state.playerX;
        const deltaY = thing.y - state.playerY;
        if (deltaX * deltaX + deltaY * deltaY > MAX_RENDER_DISTANCE * MAX_RENDER_DISTANCE) continue;

        updateSingleEnemy(index, thing, deltaTime, currentTime);
        renderer.updateEnemyRotation(index, thing);
    }
}
