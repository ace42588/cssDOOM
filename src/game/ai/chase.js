/**
 * DOOM-style 8-directional enemy chase movement.
 * Based on: linuxdoom-1.10/p_enemy.c — direction enums, xspeed/yspeed, P_NewChaseDir,
 * P_Move, P_TryWalk. Try-order and turnaround logic match P_NewChaseDir; step tests
 * use canMoveTo instead of P_TryMove/P_CheckPosition (functionally equivalent).
 * Simulation only — no renderer calls.
 */

import { MAX_STEP_HEIGHT, MELEE_RANGE } from "../constants.js";
import { debug } from "../state.js";
import { canMoveToActor } from "../physics/collision.js";
import { getFloorHeightAt } from "../physics/queries.js";
import {
  getDeltas,
} from "../geometry.js";
import { asMovementActor } from '../entity/interop.js';
import {
  integratePlanarMove,
  updateActorFacingFromDelta,
} from "../movement/system.js";
import { inRadius } from '../actors/math.js';

// ============================================================================
// DOOM fixed-point equivalents (world units)
// ============================================================================

/** P_NewChaseDir axis dead zone: 10 * FRACUNIT in linuxdoom. */
const CHASE_DELTA_DEAD_ZONE = 10;

/** P_Random() > 200 (~21%) swaps horizontal vs vertical try order. */
const CHASE_AXIS_SWAP_RANDOM_THRESHOLD = 200;
const CHASE_AXIS_SWAP_RANDOM_MAX = 255;

/** Ignore sub-pixel drift when updating facing from displacement. */
const FACING_UPDATE_MIN_DIST_SQ = 0.001;

// ============================================================================
// Direction enums — linuxdoom-1.10/p_enemy.c
// ============================================================================

const DI_EAST = 0;
const DI_NORTHEAST = 1;
const DI_NORTH = 2;
const DI_NORTHWEST = 3;
const DI_WEST = 4;
const DI_SOUTHWEST = 5;
const DI_SOUTH = 6;
const DI_SOUTHEAST = 7;
const DI_NODIR = 8;

const oppositeDir = [
  DI_WEST,
  DI_SOUTHWEST,
  DI_SOUTH,
  DI_SOUTHEAST,
  DI_EAST,
  DI_NORTHEAST,
  DI_NORTH,
  DI_NORTHWEST,
  DI_NODIR,
];

const diagDir = [DI_NORTHWEST, DI_NORTHEAST, DI_SOUTHWEST, DI_SOUTHEAST];

const dirDX = [1, 0.7071, 0, -0.7071, -1, -0.7071, 0, 0.7071];
const dirDY = [0, 0.7071, 1, 0.7071, 0, -0.7071, -1, -0.7071];

function canWalkDir(enemy, dir) {
  if (dir >= DI_NODIR) return false;
  const stepSize = (enemy.ai.speed * (enemy.ai.chaseTics || 3)) / 35;
  const testX = enemy.x + stepSize * dirDX[dir];
  const testY = enemy.y + stepSize * dirDY[dir];
  return canMoveToActor(asMovementActor(enemy), testX, testY, {
    maxDropHeight: MAX_STEP_HEIGHT,
    excludeThing: enemy,
  });
}

function commitDirection(enemy, dir) {
  enemy.ai.moveDir = dir;
  const moveCount = Math.floor(Math.random() * 16);
  enemy.ai.moveTimer = (moveCount * (enemy.ai.chaseTics || 3)) / 35;
}

/**
 * P_NewChaseDir try-order: diagonal → axes (swap per DOOM) → old dir → scan 8 →
 * turnaround → DI_NODIR. movecount → enemy.ai.moveTimer (scaled by chaseTics/35).
 */
function pickMoveDirection(enemy, target) {
  const { deltaX, deltaY } = getDeltas(enemy, target);

  const oldDir = enemy.ai.moveDir ?? DI_NODIR;
  const turnaround = oppositeDir[oldDir];

  const dz = CHASE_DELTA_DEAD_ZONE;
  let horizDir;
  let vertDir;
  if (deltaX > dz) horizDir = DI_EAST;
  else if (deltaX < -dz) horizDir = DI_WEST;
  else horizDir = DI_NODIR;

  if (deltaY < -dz) vertDir = DI_SOUTH;
  else if (deltaY > dz) vertDir = DI_NORTH;
  else vertDir = DI_NODIR;

  if (horizDir !== DI_NODIR && vertDir !== DI_NODIR) {
    const diag = diagDir[(deltaY < 0 ? 2 : 0) + (deltaX > 0 ? 1 : 0)];
    if (diag !== turnaround && canWalkDir(enemy, diag)) {
      commitDirection(enemy, diag);
      return;
    }
  }

  if (
    Math.random() * CHASE_AXIS_SWAP_RANDOM_MAX >
      CHASE_AXIS_SWAP_RANDOM_THRESHOLD ||
    Math.abs(deltaY) > Math.abs(deltaX)
  ) {
    const tmp = horizDir;
    horizDir = vertDir;
    vertDir = tmp;
  }
  if (horizDir === turnaround) horizDir = DI_NODIR;
  if (vertDir === turnaround) vertDir = DI_NODIR;

  if (horizDir !== DI_NODIR && canWalkDir(enemy, horizDir)) {
    commitDirection(enemy, horizDir);
    return;
  }
  if (vertDir !== DI_NODIR && canWalkDir(enemy, vertDir)) {
    commitDirection(enemy, vertDir);
    return;
  }

  if (
    oldDir !== DI_NODIR &&
    oldDir !== turnaround &&
    canWalkDir(enemy, oldDir)
  ) {
    commitDirection(enemy, oldDir);
    return;
  }

  if (Math.random() < 0.5) {
    for (let dir = DI_EAST; dir <= DI_SOUTHEAST; dir++) {
      if (dir !== turnaround && canWalkDir(enemy, dir)) {
        commitDirection(enemy, dir);
        return;
      }
    }
  } else {
    for (let dir = DI_SOUTHEAST; dir >= DI_EAST; dir--) {
      if (dir !== turnaround && canWalkDir(enemy, dir)) {
        commitDirection(enemy, dir);
        return;
      }
    }
  }

  if (turnaround !== DI_NODIR && canWalkDir(enemy, turnaround)) {
    commitDirection(enemy, turnaround);
    return;
  }

  enemy.ai.moveDir = DI_NODIR;
}

/**
 * A_Chase movement + P_Move: continuous delta-time (not per-tic). When moveTimer
 * expires or sliding is blocked, P_NewChaseDir runs again.
 * @returns {boolean} true if the enemy entered the movement integration path with a
 * valid direction (caller should sync thing DOM position / sector light).
 */
export function moveEnemyToward(enemy, target, deltaTime) {
  if (debug.noEnemyMove) return false;
  if (inRadius(enemy, target, MELEE_RANGE)) return false;

  enemy.ai.moveTimer = (enemy.ai.moveTimer ?? 0) - deltaTime;
  if (
    enemy.ai.moveTimer <= 0 ||
    enemy.ai.moveDir === undefined ||
    enemy.ai.moveDir === DI_NODIR
  ) {
    pickMoveDirection(enemy, target);
  }

  const dir = enemy.ai.moveDir;
  if (dir === undefined || dir >= DI_NODIR) return false;

  enemy.floorHeight = getFloorHeightAt(enemy.x, enemy.y);
  const actor = asMovementActor(enemy);
  const movement = integratePlanarMove(
    actor,
    { x: dirDX[dir] * enemy.ai.speed, y: dirDY[dir] * enemy.ai.speed },
    deltaTime,
  );
  if (!movement.moved) {
    pickMoveDirection(enemy, target);
  }

  updateActorFacingFromDelta(
    actor,
    movement.fromX,
    movement.fromY,
    FACING_UPDATE_MIN_DIST_SQ,
  );

  return true;
}
