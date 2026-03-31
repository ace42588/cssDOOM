/**
 * Teleporters
 *
 * Walk-over teleporter linedefs that instantly move the player to a destination
 * thing (type 14) in the target sector.
 *
 * Based on: linuxdoom-1.10/p_telept.c:EV_Teleport()
 * Accuracy: Approximation — same walk-over trigger + destination lookup, but we
 * use edge-detection (crossing into range) instead of DOOM's line-crossing check.
 *
 * When the player crosses a teleporter linedef:
 * 1. Player position is set to the destination coordinates.
 * 2. Player angle is set to the destination thing's angle.
 * 3. A brief green flash is shown (teleport fog).
 * 4. One-shot teleporters (W1, type 39/125) are disabled after first use.
 */

import { WALK_TRIGGER_RANGE, EYE_HEIGHT, PLAYER_RADIUS, SHOOTABLE, BARREL_RADIUS } from '../constants.js';

import { state } from '../state.js';
import { mapData } from '../../shared/maps.js';
import { getFloorHeightAt } from '../physics.js';
import * as renderer from '../../renderer/index.js';
import { playSound } from '../../audio/audio.js';
import { damageEnemy } from '../entities/combat.js';

/**
 * Checks all teleporter linedefs each frame. Uses the same closest-point-on-segment
 * approach as walk-over triggers, with edge detection to prevent repeated activation.
 */
export function checkTeleporters() {
    const teleporters = mapData.teleporters;
    if (!teleporters || teleporters.length === 0) return;

    for (let i = 0; i < teleporters.length; i++) {
        const tp = teleporters[i];
        if (tp.used) continue;

        // Compute closest point on the teleporter linedef to the player
        const dx = tp.end.x - tp.start.x;
        const dy = tp.end.y - tp.start.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) continue;

        let t = ((state.playerX - tp.start.x) * dx + (state.playerY - tp.start.y) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));

        const closestX = tp.start.x + t * dx;
        const closestY = tp.start.y + t * dy;
        const distSq = (state.playerX - closestX) ** 2 + (state.playerY - closestY) ** 2;

        const wasNear = tp._wasNear || false;
        const isNear = distSq < WALK_TRIGGER_RANGE * WALK_TRIGGER_RANGE;
        tp._wasNear = isNear;

        if (isNear && !wasNear) {
            // Save departure position for fog
            const departX = state.playerX;
            const departY = state.playerY;
            const departZ = state.floorHeight;

            // Telefrag: kill anything shootable at the destination
            // Based on: linuxdoom-1.10/p_map.c:PIT_StompThing()
            const allThings = state.things;
            for (let j = 0, len = allThings.length; j < len; j++) {
                const thing = allThings[j];
                if (thing.collected) continue;
                if (!SHOOTABLE.has(thing.type)) continue;
                const thingRadius = thing.ai ? thing.ai.radius : BARREL_RADIUS;
                const blockDist = PLAYER_RADIUS + thingRadius;
                if (Math.abs(thing.x - tp.destX) < blockDist && Math.abs(thing.y - tp.destY) < blockDist) {
                    damageEnemy(thing, 10000, 'player');
                }
            }

            // Teleport the player
            state.playerX = tp.destX;
            state.playerY = tp.destY;
            state.playerAngle = (tp.destAngle - 90) * Math.PI / 180;
            state.floorHeight = getFloorHeightAt(state.playerX, state.playerY);
            state.playerZ = state.floorHeight + EYE_HEIGHT;

            // Spawn teleport fog at departure and arrival
            // Based on: linuxdoom-1.10/p_telept.c — spawns MT_TFOG at both ends
            renderer.createTeleportFog(departX, departZ, departY);
            renderer.createTeleportFog(state.playerX, state.floorHeight, state.playerY);
            renderer.triggerFlash('teleport-flash');
            playSound('DSTELEPT');

            // Update camera immediately so there's no frame of the old position
            renderer.updateCamera();

            // Disable one-shot teleporters
            if (tp.oneShot) tp.used = true;
            break; // only one teleport per frame
        }
    }
}

