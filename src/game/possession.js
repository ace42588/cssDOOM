/**
 * Body-swap / possession state.
 *
 * One actor at a time is "controlled" by user input. When it points to
 * `player`, the vanilla input/movement/weapon path runs. When it points to
 * an enemy entry in `state.things`, the user drives that enemy — camera,
 * movement, and firing all route to the possessed monster — while the
 * `player` object stays on the map and runs under a lightweight AI.
 *
 * This module is the single source of truth for the swap. Every subsystem
 * that needs to know who is "the player right now" reads from here via
 * `getControlled()`.
 */

import {
    EYE_HEIGHT,
    ENEMIES,
    LINE_OF_SIGHT_CHECK_INTERVAL,
    MOVE_SPEED,
    PLAYER_HEIGHT,
    PLAYER_RADIUS,
    WEAPONS,
} from './constants.js';
import { state, player } from './state.js';
import { getFloorHeightAt } from './physics/queries.js';
import { getThingIndex } from './things/registry.js';
import { setEnemyState } from './ai/state.js';
import * as renderer from '../renderer/index.js';

let controlled = player;

const changeListeners = new Set();

export function onPossessionChange(listener) {
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
}

function notifyChange() {
    for (const listener of changeListeners) {
        try {
            listener(controlled);
        } catch (err) {
            if (import.meta.env.DEV) console.warn('[possession] listener error', err);
        }
    }
}

export function getControlled() {
    return controlled;
}

export function isControllingPlayer() {
    return controlled === player;
}

export function isPossessing() {
    return controlled !== player;
}

export function getControlledEyeHeight() {
    if (controlled === player) return EYE_HEIGHT;
    return EYE_HEIGHT * 0.9;
}

/**
 * Derive a Zombieman-shaped AI profile for the normal player character,
 * parameterised by whichever weapon the player has equipped.
 */
function buildPlayerAiProfile() {
    const weapon = WEAPONS[player.currentWeapon] || WEAPONS[2];
    const fireRateSeconds = (weapon.fireRate || 543) / 1000;
    return {
        state: 'idle',
        stateTime: 0,
        wakeCheckTimer: Math.random() * LINE_OF_SIGHT_CHECK_INTERVAL,
        rangedLosTimer: 0,
        lastAttack: 0,
        damageDealt: false,
        reactionTimer: 0,
        ambush: false,
        target: 'player',
        threshold: 0,
        speed: MOVE_SPEED,
        chaseTics: 4,
        radius: PLAYER_RADIUS,
        attackRange: weapon.range || 1500,
        damage: 0,
        cooldown: Math.max(0.5, fireRateSeconds),
        sightRange: 3000,
        melee: false,
        alertSound: null,
        pellets: weapon.pellets || 1,
        hitscanSound: weapon.sound || 'DSPISTOL',
        painChance: 128,
        reactionTime: 8 / 35,
        attackDuration: Math.max(0.3, fireRateSeconds),
        painDuration: 0.171,
    };
}

/** Install an AI block on `player` so the enemy controller can tick it. */
export function ensurePlayerAi() {
    if (!player.ai) {
        player.ai = buildPlayerAiProfile();
    } else {
        // Refresh weapon-derived fields in case the player swapped weapons
        const weapon = WEAPONS[player.currentWeapon] || WEAPONS[2];
        const fireRateSeconds = (weapon.fireRate || 543) / 1000;
        player.ai.cooldown = Math.max(0.5, fireRateSeconds);
        player.ai.attackDuration = Math.max(0.3, fireRateSeconds);
        player.ai.attackRange = weapon.range || 1500;
        player.ai.pellets = weapon.pellets || 1;
        player.ai.hitscanSound = weapon.sound || 'DSPISTOL';
    }
    return player.ai;
}

export function clearPlayerAi() {
    player.ai = null;
}

/** Reset an ex-possessed monster so it rejoins normal AI updates cleanly. */
function rehydrateEnemyAi(enemy) {
    if (!enemy || !enemy.ai) return;
    enemy.ai.state = 'idle';
    enemy.ai.stateTime = 0;
    enemy.ai.damageDealt = false;
    enemy.ai.reactionTimer = 0;
    enemy.ai.threshold = 0;
    enemy.ai.target = 'player';
    enemy.ai.wakeCheckTimer = 0;
    enemy.ai.rangedLosTimer = 0;
    enemy.ai.moveDir = undefined;
    enemy.ai.moveTimer = 0;
    setEnemyState(enemy, 'idle');
}

function hideThingSprite(thing, hide) {
    if (!thing) return;
    const idx = getThingIndex(thing);
    if (idx < 0) return;
    renderer.setThingVisible(idx, !hide);
}

export function possess(entity) {
    if (!entity) return false;
    if (entity === controlled) return true;

    const previous = controlled;

    if (entity !== player) {
        if (!entity.ai) return false;
        if (entity.collected) return false;
        if ((entity.hp ?? 0) <= 0) return false;
    } else {
        if (player.isDead || player.isAiDead) return false;
    }

    controlled = entity;

    if (previous && previous !== player && previous !== entity) {
        rehydrateEnemyAi(previous);
        hideThingSprite(previous, false);
    }

    if (entity === player) {
        clearPlayerAi();
    } else {
        ensurePlayerAi();
        hideThingSprite(entity, true);
    }

    notifyChange();
    return true;
}

export function possessPlayer() {
    return possess(player);
}

/**
 * Called when the currently-controlled body dies. Auto-cycles to the next
 * living body (nearest living monster first, falling back to the player
 * character if alive). If nothing is left, fires the normal death/restart
 * flow by marking the player dead.
 */
export function onPossessedDeath(entity) {
    if (entity !== controlled) return;

    const next = findNextLivingBody(entity);
    if (next) {
        // Temporarily reset so possess() detects a change vs the dying body.
        controlled = player;
        possess(next);
        return;
    }

    controlled = player;
    player.isDead = true;
    player.deathTime = performance.now();
    renderer.setPlayerDead(true);
    notifyChange();
}

function findNextLivingBody(dyingEntity) {
    const candidates = [];
    const allThings = state.things;
    for (let i = 0; i < allThings.length; i++) {
        const thing = allThings[i];
        if (thing === dyingEntity) continue;
        if (!thing.ai) continue;
        if (!ENEMIES.has(thing.type)) continue;
        if (thing.collected) continue;
        if ((thing.hp ?? 0) <= 0) continue;
        candidates.push(thing);
    }

    const origin = dyingEntity || controlled;
    candidates.sort((a, b) => {
        const da = (a.x - origin.x) * (a.x - origin.x) + (a.y - origin.y) * (a.y - origin.y);
        const db = (b.x - origin.x) * (b.x - origin.x) + (b.y - origin.y) * (b.y - origin.y);
        return da - db;
    });

    if (candidates.length > 0) return candidates[0];

    if (!player.isDead && !player.isAiDead && dyingEntity !== player) {
        return player;
    }
    return null;
}

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

/** Snapshot of living bodies for the picker UI. */
export function listAvailableBodies() {
    const bodies = [];
    if (!player.isDead && !player.isAiDead) {
        bodies.push({
            kind: 'player',
            label: 'You (marine)',
            type: null,
            hp: Math.round(player.health),
            maxHp: 100,
            isControlled: controlled === player,
            entity: player,
        });
    }

    const allThings = state.things;
    for (let i = 0; i < allThings.length; i++) {
        const thing = allThings[i];
        if (!thing.ai) continue;
        if (!ENEMIES.has(thing.type)) continue;
        if (thing.collected) continue;
        if ((thing.hp ?? 0) <= 0) continue;
        bodies.push({
            kind: 'enemy',
            label: enemyLabel(thing.type),
            type: thing.type,
            hp: Math.round(thing.hp),
            maxHp: thing.maxHp ?? thing.hp,
            isControlled: controlled === thing,
            entity: thing,
        });
    }

    return bodies;
}

/**
 * Reset possession state at map load. Any currently-possessed monster
 * should forget its possessed flag — the map's sprites were rebuilt.
 */
export function resetPossession() {
    const previous = controlled;
    controlled = player;
    clearPlayerAi();
    player.isAiDead = false;
    if (previous && previous !== player) {
        // Previous monster's DOM is gone after level rebuild; nothing to do.
    }
    notifyChange();
}

/** Position/angle snapshot used by the camera. */
export function getControlledEye() {
    if (controlled === player) {
        return {
            x: player.x,
            y: player.y,
            z: player.z,
            angle: player.angle,
            floorHeight: player.floorHeight,
        };
    }
    const thing = controlled;
    const floor = getFloorHeightAt(thing.x, thing.y);
    thing.floorHeight = floor;
    const eyeAngle = typeof thing.viewAngle === 'number'
        ? thing.viewAngle
        : (thing.facing ?? 0);
    return {
        x: thing.x,
        y: thing.y,
        z: floor + getControlledEyeHeight(),
        angle: eyeAngle,
        floorHeight: floor,
    };
}

export function getControlledRadius() {
    if (controlled === player) return player.radius ?? PLAYER_RADIUS;
    return controlled.ai?.radius ?? PLAYER_RADIUS;
}

export function getControlledHeight() {
    if (controlled === player) return player.height ?? PLAYER_HEIGHT;
    return PLAYER_HEIGHT;
}

export function getControlledSpeed() {
    if (controlled === player) return player.speed;
    return controlled.ai?.speed ?? MOVE_SPEED;
}
