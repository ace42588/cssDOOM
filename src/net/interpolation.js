import * as rendererFacade from '../renderer/index.js';
import { setRenderInterp } from '../game/possession.js';
import { session } from './session.js';

export const thingInterp = new Map();
export const projectileInterp = new Map();

const INTERP_MAX_T = 1.25;
const RENDER_INTERP_DURATION_FACTOR = 1.5;

let playerInterp = null;
let playerRenderInitialized = false;
const playerRender = { x: 0, y: 0, z: 0, floor: 0, angle: 0 };

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

function currentPlayerInterpPose(entry, now) {
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

function tickPlayerInterp() {
    if (playerInterp) {
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const pose = currentPlayerInterpPose(playerInterp, now);
        playerRender.x = pose.x;
        playerRender.y = pose.y;
        playerRender.z = pose.z;
        playerRender.floor = pose.floor;
        playerRender.angle = pose.angle;
        if ((now - playerInterp.t0) >= playerInterp.dt) {
            playerInterp = null;
        }
    }
    requestAnimationFrame(tickPlayerInterp);
}

export function getRenderedPlayerPose() {
    return playerRender;
}

export function updatePlayerRenderFromSnapshot(player, prev) {
    if (!playerRenderInitialized) {
        playerRender.x = player.x;
        playerRender.y = player.y;
        playerRender.z = player.z;
        playerRender.floor = player.floorHeight || 0;
        playerRender.angle = player.viewAngle;
        playerRenderInitialized = true;
        playerInterp = null;
        return;
    }

    const moved =
        prev.x !== player.x ||
        prev.y !== player.y ||
        prev.z !== player.z ||
        prev.floorHeight !== player.floorHeight ||
        prev.angle !== player.viewAngle;
    if (!moved) return;

    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    playerInterp = {
        fromX: playerRender.x,
        fromY: playerRender.y,
        fromZ: playerRender.z,
        fromFloor: playerRender.floor,
        fromAngle: playerRender.angle,
        toX: player.x,
        toY: player.y,
        toZ: player.z,
        toFloor: player.floorHeight || 0,
        toAngle: player.viewAngle,
        t0: now,
        dt: renderInterpDt(),
    };
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
    playerInterp = null;
    playerRenderInitialized = false;
}

if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(tickThingInterp);
    requestAnimationFrame(tickPlayerInterp);
    requestAnimationFrame(tickProjectileInterp);
}

setRenderInterp({ getRenderedPlayerPose, getRenderedThingPose });

