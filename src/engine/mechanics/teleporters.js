/**
 * Teleporters
 *
 * Walk-over teleporter linedefs that instantly move any hazard-susceptible
 * actor to a destination thing (type 14) in the target sector.
 *
 * Based on: linuxdoom-1.10/p_telept.c:EV_Teleport()
 * Accuracy: Approximation — same walk-over trigger + destination lookup, using
 * line-crossing detection matching DOOM's original behaviour.
 *
 * When an eligible actor crosses a teleporter linedef:
 * 1. Actor position is set to the destination coordinates.
 * 2. Actor view/facing angle is set to the destination thing's angle.
 * 3. A brief green flash is shown (teleport fog) — fires for any actor today
 *    because only the marine is hazard-susceptible by default.
 * 4. One-shot teleporters (W1, type 39/125) are disabled after first use.
 *
 * Hazard scope: any actor whose `movement.hazardSusceptible === true` may
 * teleport. Marine defaults true; monsters default false (behavior matches
 * today). Each actor is tracked independently per teleporter via the
 * `_actorPrevSides` WeakMap so simultaneous crossings stay sane.
 */

import { EYE_HEIGHT, PLAYER_RADIUS, SHOOTABLE, BARREL_RADIUS } from '../constants.js';

import { state } from '../state.js';
import { mapData } from '../data/maps.js';
import { getFloorHeightAt } from '../physics/queries.js';
import * as renderer from '../ports/renderer.js';
import { playSound } from '../ports/audio.js';
import { applyDamage } from '../combat/damage.js';

function getOrCreatePrevSides(teleporter) {
    if (!teleporter._actorPrevSides) {
        teleporter._actorPrevSides = new WeakMap();
    }
    return teleporter._actorPrevSides;
}

/**
 * Each frame: for every hazard-susceptible actor, check whether it crossed any
 * unused teleporter linedef. If so, telefrag any shootables at the destination
 * and move the actor there. Crossing detection mirrors the original DOOM
 * behaviour (linuxdoom-1.10/p_spec.c:P_CrossSpecialLine).
 */
export function checkTeleporters() {
    const teleporters = mapData.teleporters;
    if (!teleporters || teleporters.length === 0) return;

    for (let actorIdx = 0, alen = state.actors.length; actorIdx < alen; actorIdx++) {
        const actor = state.actors[actorIdx];
        if (!actor) continue;
        if (actor.collected || (actor.hp ?? 0) <= 0) continue;
        if (!actor.movement?.hazardSusceptible) continue;

        for (let tpIdx = 0; tpIdx < teleporters.length; tpIdx++) {
            const tp = teleporters[tpIdx];
            if (tp.used) continue;

            const prevSides = getOrCreatePrevSides(tp);
            const dx = tp.end.x - tp.start.x;
            const dy = tp.end.y - tp.start.y;
            const side = (actor.x - tp.start.x) * dy - (actor.y - tp.start.y) * dx;
            const currentSide = side > 0;

            const previousSide = prevSides.get(actor);
            prevSides.set(actor, currentSide);

            // First frame this actor is observed: just record the side, don't fire.
            if (previousSide === undefined) continue;
            if (previousSide === currentSide) continue;

            teleportActor(actor, tp);
            if (tp.oneShot) tp.used = true;
            // Only one teleport per actor per frame (DOOM parity).
            break;
        }
    }
}

function teleportActor(actor, tp) {
    const departX = actor.x;
    const departY = actor.y;
    const departZ = actor.floorHeight;

    // Telefrag: kill anything shootable at the destination.
    // Based on: linuxdoom-1.10/p_map.c:PIT_StompThing()
    const stompRadius = (actor.radius ?? PLAYER_RADIUS);
    for (let j = 0, alen = state.actors.length; j < alen; j++) {
        const other = state.actors[j];
        if (!other || other === actor || other.collected) continue;
        if (!SHOOTABLE.has(other.type)) continue;
        const otherRadius = other.ai ? other.ai.radius : BARREL_RADIUS;
        const blockDist = stompRadius + otherRadius;
        if (Math.abs(other.x - tp.destX) < blockDist && Math.abs(other.y - tp.destY) < blockDist) {
            applyDamage(other, 10000, actor, { kind: 'telefrag' });
        }
    }
    for (let j = 0, len = state.things.length; j < len; j++) {
        const thing = state.things[j];
        if (!thing || thing.collected) continue;
        if (!SHOOTABLE.has(thing.type)) continue;
        const thingRadius = thing.ai ? thing.ai.radius : BARREL_RADIUS;
        const blockDist = stompRadius + thingRadius;
        if (Math.abs(thing.x - tp.destX) < blockDist && Math.abs(thing.y - tp.destY) < blockDist) {
            applyDamage(thing, 10000, actor, { kind: 'telefrag' });
        }
    }

    actor.x = tp.destX;
    actor.y = tp.destY;
    actor.viewAngle = (tp.destAngle - 90) * Math.PI / 180;
    actor.facing = actor.viewAngle + Math.PI / 2;
    actor.floorHeight = getFloorHeightAt(actor.x, actor.y);
    actor.z = actor.floorHeight + EYE_HEIGHT;

    // Spawn teleport fog at departure and arrival
    // Based on: linuxdoom-1.10/p_telept.c — spawns MT_TFOG at both ends
    renderer.createTeleportFog(departX, departZ, departY);
    renderer.createTeleportFog(actor.x, actor.floorHeight, actor.y);
    renderer.triggerFlash('teleport-flash');
    playSound('DSTELEPT');
    renderer.updateCamera();
}
