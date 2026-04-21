/**
 * Body-swap / possession state — generalized for multi-controller (server).
 *
 * At any point zero or more "controllers" (session ids) are each bound to a
 * single body (the marine `player` in `state.actors[0]`, an enemy in
 * `state.actors[1..]`, a `state.things` entry, or a door entity).
 * A body can be controlled by at most one controller. Bodies not controlled
 * by any human run under AI.
 *
 * Browser single-player uses the default session id `'local'` and the legacy
 * single-controller API (`getControlled()`, `possess()`, `isControllingPlayer()`)
 * still works exactly as before.
 *
 * Server multiplayer uses the keyed API (`possessFor(sessionId, entity)`,
 * `releaseFor(sessionId)`, `getControlledFor(sessionId)`,
 * `isHumanControlled(entity)`, `listHumanControlledEntities()`) — one entry
 * per connected client that holds a playable body; spectators hold none.
 *
 * Every subsystem that needs to know "is this body a human?" should go
 * through `isHumanControlled(entity)`.
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
import { state, getMarine } from './state.js';

const marine = () => getMarine();
import { getFloorHeightAt } from './physics/queries.js';
import { getThingIndex } from './things/registry.js';
import { setEnemyState } from './ai/state.js';
import * as renderer from '../renderer/index.js';
import { formatRuntimeId } from './entity/id.js';

function isDoorEntity(entity) {
    return Boolean(entity && entity.__isDoorEntity);
}

export const LOCAL_SESSION = 'local';

// Optional render-side interpolation hooks. The browser net client wires
// these in at startup so `getControlledEye()` can return the lerped pose
// for the local marine and any possessed/spectated thing without forcing
// `possession.js` to import browser-only modules. Both default to no-ops
// so server / headless paths see the snapshot-truth fields directly.
let renderedPlayerPoseFn = null;
let renderedThingPoseFn = null;

export function setRenderInterp({ getRenderedPlayerPose, getRenderedThingPose } = {}) {
    renderedPlayerPoseFn = typeof getRenderedPlayerPose === 'function' ? getRenderedPlayerPose : null;
    renderedThingPoseFn = typeof getRenderedThingPose === 'function' ? getRenderedThingPose : null;
}

/**
 * sessionId → entity. Empty at startup: in the multiplayer world the
 * server owns every binding, and the first joining client is what
 * claims the marine. The browser populates its own `LOCAL_SESSION`
 * entry when the first server snapshot arrives (see
 * `src/net/client.js#syncLocalPossession`). Legacy single-player
 * helpers below fall back to `player` when no local binding exists.
 */
const controllers = new Map();

const changeListeners = new Set();

export function onPossessionChange(listener) {
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
}

function notifyChange(sessionId, entity) {
    for (const listener of changeListeners) {
        try {
            listener(entity, sessionId);
        } catch (err) {
            if (typeof console !== 'undefined') {
                try { console.warn('[possession] listener error', err); } catch {}
            }
        }
    }
}

// ── Keyed API (server / multi-controller) ─────────────────────────────

/** Return the entity controlled by `sessionId`, or null. */
export function getControlledFor(sessionId) {
    return controllers.get(sessionId) || null;
}

/** True if any session currently controls `entity`. */
export function isHumanControlled(entity) {
    if (!entity) return false;
    for (const controlled of controllers.values()) {
        if (controlled === entity) return true;
    }
    return false;
}

/** Return the sessionId controlling `entity`, or null if no one does. */
export function getSessionIdControlling(entity) {
    if (!entity) return null;
    for (const [sid, controlled] of controllers) {
        if (controlled === entity) return sid;
    }
    return null;
}

/** Iterator of `[sessionId, entity]` for every currently-assigned body. */
export function listHumanControlledEntries() {
    return [...controllers.entries()];
}

/** List of entities currently controlled by a human session. */
export function listHumanControlledEntities() {
    return [...controllers.values()];
}

// ── Legacy single-controller API (browser) ────────────────────────────

/**
 * Returns the entity controlled by the local session. Falls back to the
 * marine for legacy single-player code paths that run before any binding
 * exists (e.g. the browser HUD on the first pre-snapshot frame).
 */
export function getControlled() {
    return controllers.get(LOCAL_SESSION) || marine();
}

export function isControllingPlayer() {
    const controlled = controllers.get(LOCAL_SESSION);
    // No binding means "default view": treat as if controlling the marine.
    return !controlled || controlled === marine();
}

export function isPossessing() {
    const controlled = controllers.get(LOCAL_SESSION);
    return Boolean(controlled) && controlled !== marine();
}

export function getControlledEyeHeight() {
    const controlled = controllers.get(LOCAL_SESSION);
    if (controlled === marine()) return EYE_HEIGHT;
    return EYE_HEIGHT * 0.9;
}

/**
 * Derive a Zombieman-shaped AI profile for the normal player character,
 * parameterised by whichever weapon the player has equipped.
 */
function buildPlayerAiProfile() {
    const weapon = WEAPONS[marine().currentWeapon] || WEAPONS[2];
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
    if (!marine().ai) {
        marine().ai = buildPlayerAiProfile();
    } else {
        const weapon = WEAPONS[marine().currentWeapon] || WEAPONS[2];
        const fireRateSeconds = (weapon.fireRate || 543) / 1000;
        marine().ai.cooldown = Math.max(0.5, fireRateSeconds);
        marine().ai.attackDuration = Math.max(0.3, fireRateSeconds);
        marine().ai.attackRange = weapon.range || 1500;
        marine().ai.pellets = weapon.pellets || 1;
        marine().ai.hitscanSound = weapon.sound || 'DSPISTOL';
    }
    return marine().ai;
}

export function clearPlayerAi() {
    marine().ai = null;
}

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

// ── Core possession logic (used by both legacy + keyed APIs) ──────────

/**
 * Bind `sessionId` to `entity`. Returns true on success, false if the entity
 * is invalid or already controlled by a *different* session.
 */
export function possessFor(sessionId, entity) {
    if (!entity) return false;

    // Reject if already owned by someone else.
    for (const [sid, controlled] of controllers) {
        if (controlled === entity && sid !== sessionId) return false;
    }

    if (isDoorEntity(entity)) {
        // Doors are always available; no hp/collected gate.
    } else if (entity !== marine()) {
        if (!entity.ai) return false;
        if (entity.collected) return false;
        if ((entity.hp ?? 0) <= 0) return false;
    } else {
        if (marine().hp <= 0 || marine().deathMode) return false;
    }

    const previous = controllers.get(sessionId) || null;
    if (previous === entity) return true;

    controllers.set(sessionId, entity);

    // If the previous body is no longer controlled by *any* session, rejoin AI.
    if (previous && previous !== entity && !isHumanControlled(previous)) {
        if (previous !== marine() && !isDoorEntity(previous)) {
            rehydrateEnemyAi(previous);
            hideThingSprite(previous, false);
        }
    }

    // Install AI on `player` if the marine is no longer controlled by anyone.
    if (!isHumanControlled(marine())) {
        ensurePlayerAi();
    } else {
        clearPlayerAi();
    }

    if (entity !== marine() && !isDoorEntity(entity)) {
        // The controlled monster's sprite is hidden so the camera eye doesn't
        // look at the inside of the sprite it's driving. On the server this
        // is a no-op through the recording host.
        hideThingSprite(entity, true);
    }

    notifyChange(sessionId, entity);
    return true;
}

/** Release `sessionId`'s hold on whatever body it controls. Body reverts to AI. */
export function releaseFor(sessionId) {
    const previous = controllers.get(sessionId);
    if (!previous) return;
    controllers.delete(sessionId);

    if (!isHumanControlled(previous)) {
        if (previous === marine()) {
            ensurePlayerAi();
        } else if (isDoorEntity(previous)) {
            // no-op
        } else {
            rehydrateEnemyAi(previous);
            hideThingSprite(previous, false);
        }
    }

    notifyChange(sessionId, null);
}

/** Back-compat alias — possess an entity for the local session. */
export function possess(entity) {
    return possessFor(LOCAL_SESSION, entity);
}

export function possessPlayer() {
    return possessFor(LOCAL_SESSION, marine());
}

/**
 * Called when the currently-controlled body dies. Auto-cycles to the next
 * living body (nearest living monster first, falling back to the player
 * character if alive). If nothing is left, fires the normal death/restart
 * flow by marking the player dead.
 */
export function onPossessedDeath(entity) {
    const sid = getSessionIdControlling(entity);
    if (!sid) return;

    const next = findNextLivingBody(entity);
    if (next) {
        controllers.set(sid, marine()); // allow possessFor to detect the change
        possessFor(sid, next);
        return;
    }

    // No living body available. For the local session this triggers the
    // normal game-over flow; for remote sessions the caller should promote
    // the client to spectator via releaseFor().
    controllers.set(sid, marine());
    if (sid === LOCAL_SESSION) {
        marine().deathMode = 'gameover';
        marine().hp = 0;
        marine().deathTime = performance.now();
        renderer.setPlayerDead(true);
    }
    notifyChange(sid, marine());
}

function findNextLivingBody(dyingEntity) {
    const candidates = [];
    for (let i = 1; i < state.actors.length; i++) {
        const thing = state.actors[i];
        if (!thing || thing === dyingEntity) continue;
        if (!thing.ai) continue;
        if (!ENEMIES.has(thing.type)) continue;
        if (thing.collected) continue;
        if ((thing.hp ?? 0) <= 0) continue;
        if (isHumanControlled(thing)) continue; // don't steal another session's body
        candidates.push(thing);
    }

    const origin = dyingEntity;
    candidates.sort((a, b) => {
        const da = (a.x - origin.x) * (a.x - origin.x) + (a.y - origin.y) * (a.y - origin.y);
        const db = (b.x - origin.x) * (b.x - origin.x) + (b.y - origin.y) * (b.y - origin.y);
        return da - db;
    });

    if (candidates.length > 0) return candidates[0];

    if (marine().hp > 0 && !marine().deathMode && dyingEntity !== marine() && !isHumanControlled(marine())) {
        return marine();
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
    const localControlled = controllers.get(LOCAL_SESSION);
    if (marine().hp > 0 && !marine().deathMode) {
        bodies.push({
            kind: 'player',
            label: 'You (marine)',
            type: null,
            hp: Math.round(marine().hp),
            maxHp: 100,
            isControlled: localControlled === marine(),
            entity: marine(),
        });
    }

    for (let i = 1; i < state.actors.length; i++) {
        const thing = state.actors[i];
        if (!thing || !thing.ai) continue;
        if (!ENEMIES.has(thing.type)) continue;
        if (thing.collected) continue;
        if ((thing.hp ?? 0) <= 0) continue;
        bodies.push({
            kind: 'enemy',
            label: enemyLabel(thing.type),
            type: thing.type,
            hp: Math.round(thing.hp),
            maxHp: thing.maxHp ?? thing.hp,
            isControlled: localControlled === thing,
            entity: thing,
        });
    }

    for (const [sectorIndex, doorEntry] of state.doorState) {
        const doorEntity = doorEntry.doorEntity;
        if (!doorEntity) continue;
        bodies.push({
            kind: 'door',
            label: `Door #${sectorIndex}`,
            type: null,
            hp: null,
            maxHp: null,
            keyRequired: doorEntity.keyRequired || null,
            isControlled: localControlled === doorEntity,
            sectorIndex,
            entity: doorEntity,
        });
    }

    return bodies;
}

/**
 * Build a human-readable summary of the interactor trying to open a door.
 * Used by the operator modal (`src/ui/door-operator.js`) and included in
 * the server snapshot so remote operators see the same information.
 */
export function describeInteractor(entity) {
    if (!entity) return { id: 'unknown', label: 'Unknown', details: {} };
    if (entity === marine()) {
        const sessionId = getSessionIdControlling(entity);
        return {
            id: formatRuntimeId(entity),
            label: sessionId ? 'Marine' : 'Marine (AI)',
            details: {
                kind: 'marine',
                health: Math.round(marine().hp),
                armor: Math.round(marine().armor),
                keys: [...marine().collectedKeys],
                weapon: marine().currentWeapon,
                sessionId,
            },
        };
    }
    if (isDoorEntity(entity)) {
        return {
            id: formatRuntimeId(entity),
            label: `Door #${entity.sectorIndex}`,
            details: { kind: 'door' },
        };
    }
    const sessionId = getSessionIdControlling(entity);
    const type = entity.type;
    const aiLabel = enemyLabel(type);
    return {
        id: formatRuntimeId(entity) ?? 'unknown',
        label: sessionId ? `${aiLabel} (human)` : aiLabel,
        details: {
            kind: ENEMIES.has(type) ? 'enemy' : 'thing',
            type,
            hp: entity.hp != null ? Math.round(entity.hp) : null,
            maxHp: entity.maxHp ?? null,
            sessionId,
        },
    };
}

/**
 * Reset possession state at map load. Every session loses its body. The
 * local session is *not* auto-rebound to the marine here — on the server
 * that would lock the first joining client out of the marine slot, and
 * on the browser the net client rebinds LOCAL_SESSION from the next
 * snapshot anyway.
 */
export function resetPossession() {
    controllers.clear();
    clearPlayerAi();
    marine().deathMode = null;
    notifyChange(LOCAL_SESSION, null);
}

/** Position/angle snapshot used by the camera. Default: local session. */
export function getControlledEye(sessionId = LOCAL_SESSION) {
    const controlled = controllers.get(sessionId) || marine();
    if (controlled === marine()) {
        const rendered = renderedPlayerPoseFn?.();
        if (rendered) {
            return {
                x: rendered.x,
                y: rendered.y,
                // z and floor lerp on the same dt as x/y so the eye
                // height stays glued to horizontal motion on stairs/lifts.
                z: rendered.z,
                angle: rendered.angle,
                floorHeight: rendered.floor,
            };
        }
        return {
            x: marine().x,
            y: marine().y,
            z: marine().z,
            angle: marine().viewAngle,
            floorHeight: marine().floorHeight,
        };
    }
    if (isDoorEntity(controlled)) {
        // The security-camera pose is fixed at map-load; only viewAngle moves.
        return {
            x: controlled.x,
            y: controlled.y,
            z: controlled.z,
            angle: controlled.viewAngle ?? 0,
            floorHeight: controlled.floorHeight,
        };
    }
    const thing = controlled;
    const rendered = renderedThingPoseFn?.(thing.thingIndex);
    const sx = rendered ? rendered.x : thing.x;
    const sy = rendered ? rendered.y : thing.y;
    // Use the lerped floor when available; the un-lerped fallback comes
    // from `getFloorHeightAt` so we never write back into `thing` from
    // this renderer-facing read. Mutating `thing.floorHeight` here would
    // smear the snapshot truth with sub-tick interpolated values, which
    // any non-render reader (HUD overlays, debug panels, sound panners)
    // would then see as a jittery height instead of the authoritative
    // server value.
    const floor = rendered ? rendered.floor : getFloorHeightAt(thing.x, thing.y);
    const eyeAngle = typeof thing.viewAngle === 'number'
        ? thing.viewAngle
        : (thing.facing ?? 0);
    return {
        x: sx,
        y: sy,
        z: floor + getControlledEyeHeight(),
        angle: eyeAngle,
        floorHeight: floor,
    };
}

export function getControlledRadius(sessionId = LOCAL_SESSION) {
    const controlled = controllers.get(sessionId) || marine();
    if (controlled === marine()) return marine().radius ?? PLAYER_RADIUS;
    if (isDoorEntity(controlled)) return 0;
    return controlled.ai?.radius ?? PLAYER_RADIUS;
}

export function getControlledHeight(sessionId = LOCAL_SESSION) {
    const controlled = controllers.get(sessionId) || marine();
    if (controlled === marine()) return marine().height ?? PLAYER_HEIGHT;
    if (isDoorEntity(controlled)) return 0;
    return PLAYER_HEIGHT;
}

/**
 * Floor for the effective move speed of a human-controlled monster, as a
 * fraction of MOVE_SPEED. AI chase speeds (70–175 u/s) feel sluggish under
 * direct control compared to the marine's 300 u/s, so we lift slow bodies
 * up to "almost marine" without slowing intrinsically fast ones (Demon at
 * 175 still rides its native value if it exceeds the floor).
 */
const POSSESSED_SPEED_FLOOR_RATIO = 0.85;

export function getControlledSpeed(sessionId = LOCAL_SESSION) {
    const controlled = controllers.get(sessionId) || marine();
    if (controlled === marine()) return marine().speed;
    if (isDoorEntity(controlled)) return 0;
    const aiSpeed = controlled.ai?.speed ?? MOVE_SPEED;
    return Math.max(aiSpeed, MOVE_SPEED * POSSESSED_SPEED_FLOOR_RATIO);
}
