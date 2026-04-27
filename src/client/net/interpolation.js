import * as rendererFacade from '../../engine/ports/renderer.js';
import { setRenderInterp } from '../../engine/possession.js';
import { getMarineActor } from '../../engine/state.js';
import { ACTOR_DOM_KEY_OFFSET } from '../../engine/constants.js';
import { session } from './session.js';

/**
 * Rendering interpolation state.
 *
 * All entities — marine, enemy actors, pickups/barrels/decorations in
 * `state.things`, and projectiles — share a common interp-table shape. Actors
 * additionally lerp `z` and `angle` (viewing angle) so the first-person
 * camera and third-person billboard can read a smooth pose between server
 * snapshots. A persistent `actorPoseCache` keeps the last rendered pose per
 * actor so callers like `getRenderedPlayerPose()` can still sample a sane
 * value once an interpolation segment completes and the `actorInterp` entry
 * is discarded.
 */
export const thingInterp = new Map();
export const projectileInterp = new Map();

const actorInterp = new Map();
const actorPoseCache = new Map();

const INTERP_MAX_T = 1.25;
const RENDER_INTERP_DURATION_FACTOR = 1.5;

const ZERO_POSE = Object.freeze({ x: 0, y: 0, z: 0, floor: 0, angle: 0 });

export function renderInterpDt() {
    return Math.max(16, RENDER_INTERP_DURATION_FACTOR * 1000 / (session.tickRateHz || 35));
}

export function currentInterpPos(entry, now) {
    const elapsed = now - entry.t0;
    const t = Math.max(0, Math.min(INTERP_MAX_T, elapsed / entry.dt));
    return {
        x: entry.fromX + (entry.toX - entry.fromX) * t,
        y: entry.fromY + (entry.toY - entry.fromY) * t,
        floor: entry.fromFloor + (entry.toFloor - entry.fromFloor) * t,
    };
}

function tickThingInterp() {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    for (const [thingIndex, entry] of thingInterp) {
        const pos = currentInterpPos(entry, now);
        rendererFacade.updateThingPosition(thingIndex, {
            x: pos.x,
            y: pos.y,
            floorHeight: pos.floor,
        });
        if (entry.pendingSectorIndex !== undefined &&
            (now - entry.t0) >= entry.dt) {
            rendererFacade.reparentThingToSector(thingIndex, entry.pendingSectorIndex);
            entry.pendingSectorIndex = undefined;
        }
        if ((now - entry.t0) >= entry.dt * INTERP_MAX_T) {
            if (entry.pendingSectorIndex !== undefined) {
                rendererFacade.reparentThingToSector(thingIndex, entry.pendingSectorIndex);
            }
            thingInterp.delete(thingIndex);
        }
    }
    requestAnimationFrame(tickThingInterp);
}

export function getRenderedThingPose(id) {
    const entry = thingInterp.get(id);
    if (!entry) return null;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    return currentInterpPos(entry, now);
}

function shortestArcLerp(fromAngle, toAngle, t) {
    let delta = toAngle - fromAngle;
    delta = ((delta + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    return fromAngle + delta * t;
}

function currentActorPose(entry, now) {
    const elapsed = now - entry.t0;
    const t = Math.max(0, Math.min(1, elapsed / entry.dt));
    return {
        x: entry.fromX + (entry.toX - entry.fromX) * t,
        y: entry.fromY + (entry.toY - entry.fromY) * t,
        z: entry.fromZ + (entry.toZ - entry.fromZ) * t,
        floor: entry.fromFloor + (entry.toFloor - entry.fromFloor) * t,
        angle: shortestArcLerp(entry.fromAngle, entry.toAngle, t),
    };
}

function actorDomId(actorIndex) {
    return ACTOR_DOM_KEY_OFFSET + actorIndex;
}

function tickActorInterp() {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    for (const [actorIndex, entry] of actorInterp) {
        const pose = currentActorPose(entry, now);
        const cached = actorPoseCache.get(actorIndex);
        if (cached) {
            cached.x = pose.x;
            cached.y = pose.y;
            cached.z = pose.z;
            cached.floor = pose.floor;
            cached.angle = pose.angle;
        } else {
            actorPoseCache.set(actorIndex, { ...pose });
        }
        // Billboards for non-marine actors live in the thing DOM pool; push
        // the lerped ground position into that DOM the same way
        // `tickThingInterp` does for pickups/barrels. The marine's external
        // billboard (`#avatar`) reads the pose cache from `camera.js`
        // instead.
        const domId = actorDomId(actorIndex);
        rendererFacade.updateThingPosition(domId, {
            x: pose.x,
            y: pose.y,
            floorHeight: pose.floor,
        });
        if (entry.pendingSectorIndex !== undefined &&
            (now - entry.t0) >= entry.dt) {
            rendererFacade.reparentThingToSector(domId, entry.pendingSectorIndex);
            entry.pendingSectorIndex = undefined;
        }
        if ((now - entry.t0) >= entry.dt) {
            if (entry.pendingSectorIndex !== undefined) {
                rendererFacade.reparentThingToSector(domId, entry.pendingSectorIndex);
            }
            actorInterp.delete(actorIndex);
        }
    }
    requestAnimationFrame(tickActorInterp);
}

/**
 * Record a newly-arrived actor pose. The first snapshot seeds the pose cache
 * without interpolation; subsequent snapshots lerp from the last rendered
 * pose to the incoming one so x/y/z/floor/angle stay glued.
 */
export function updateActorRenderFromSnapshot(actorIndex, next, prev, pendingSectorIndex) {
    const seed = () => ({
        x: next.x,
        y: next.y,
        z: next.z,
        floor: next.floor,
        angle: next.angle,
    });
    if (!actorPoseCache.has(actorIndex)) {
        actorPoseCache.set(actorIndex, seed());
        actorInterp.delete(actorIndex);
        return;
    }
    const moved =
        prev.x !== next.x ||
        prev.y !== next.y ||
        prev.z !== next.z ||
        prev.floor !== next.floor ||
        prev.angle !== next.angle;
    if (!moved) return;

    const cached = actorPoseCache.get(actorIndex);
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    actorInterp.set(actorIndex, {
        fromX: cached.x,
        fromY: cached.y,
        fromZ: cached.z,
        fromFloor: cached.floor,
        fromAngle: cached.angle,
        toX: next.x,
        toY: next.y,
        toZ: next.z,
        toFloor: next.floor,
        toAngle: next.angle,
        t0: now,
        dt: renderInterpDt(),
        pendingSectorIndex,
    });
}

export function getRenderedActorPose(actorIndex) {
    return actorPoseCache.get(actorIndex) ?? null;
}

/**
 * Pose of the marine-type actor as sampled by the renderer (third-person
 * billboard) and the first-person camera. Returns `ZERO_POSE` before the
 * first snapshot lands so the camera never touches NaN.
 */
export function getRenderedPlayerPose() {
    const marine = getMarineActor();
    if (!marine) return ZERO_POSE;
    const actorIndex = marine.actorIndex;
    if (typeof actorIndex !== 'number') return ZERO_POSE;
    const cached = actorPoseCache.get(actorIndex);
    if (cached) return cached;
    return {
        x: marine.x,
        y: marine.y,
        z: marine.z,
        floor: marine.floorHeight || 0,
        angle: marine.viewAngle || 0,
    };
}

export function dropActorInterp(actorIndex) {
    actorInterp.delete(actorIndex);
    actorPoseCache.delete(actorIndex);
}

export function currentProjectileInterpPos(entry, now) {
    const elapsed = now - entry.t0;
    const t = Math.max(0, Math.min(1, elapsed / entry.dt));
    return {
        x: entry.fromX + (entry.toX - entry.fromX) * t,
        y: entry.fromY + (entry.toY - entry.fromY) * t,
        z: entry.fromZ + (entry.toZ - entry.fromZ) * t,
    };
}

function tickProjectileInterp() {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    for (const [id, entry] of projectileInterp) {
        const pos = currentProjectileInterpPos(entry, now);
        rendererFacade.updateProjectilePosition(id, pos);
        if ((now - entry.t0) >= entry.dt) {
            projectileInterp.delete(id);
        }
    }
    requestAnimationFrame(tickProjectileInterp);
}

export function resetInterpolationState() {
    thingInterp.clear();
    projectileInterp.clear();
    actorInterp.clear();
    actorPoseCache.clear();
}

if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(tickThingInterp);
    requestAnimationFrame(tickActorInterp);
    requestAnimationFrame(tickProjectileInterp);
}

setRenderInterp({ getRenderedPlayerPose, getRenderedThingPose, getRenderedActorPose });
