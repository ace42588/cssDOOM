/**
 * Switch interaction and action triggering.
 *
 * How switch interaction works:
 * 1. When the "use" key is pressed, a forward ray is cast from the
 *    controller's position along their facing direction, reaching a point at
 *    half the USE_RANGE distance ahead.
 * 2. Every wall element in the scene is checked. Walls whose texture name
 *    begins with the switch-on or switch-off prefix are switch candidates.
 * 3. For each candidate, we project the forward check-point onto the wall's
 *    line segment (clamped to the segment endpoints) and measure the distance.
 *    If the distance is within USE_RANGE, the switch is activated.
 * 4. Activation toggles the switch's visual state (on/off) and looks up the
 *    associated linedef to determine what action to trigger:
 *      - Exit specials: returned to the caller as a pending exit action so
 *        the authoritative owner (server) can drive the map reload and
 *        broadcast it. `tryUseSwitch` itself does not call `loadMap` —
 *        that would require the browser-only level loader and would skip
 *        the server's rebroadcast step.
 *      - Sector-tagged linedefs: toggle any doors or activate any lifts
 *        whose sector matches the linedef's sector tag.
 * 5. Only the first matching switch is activated per use attempt (early return).
 */

import {
    USE_RANGE, SWITCH_ON_PREFIX, SWITCH_OFF_PREFIX,
    EXIT_SPECIAL, SECRET_EXIT_SPECIAL,
} from '../constants.js';

import { state, player } from '../state.js';
import { mapData } from '../../data/maps.js';
import { toggleDoor } from './doors.js';
import { activateLift } from './lifts.js';
import { activateCrusher } from './crushers.js';
import * as renderer from '../../renderer/index.js';

/**
 * Attempt to activate a switch in front of `requestedBy` (the body holding
 * the "use" key). Mirrors `tryOpenDoor(requestedBy)` so possessed bodies
 * hit switches from their own position/angle rather than the marine's.
 *
 * Returns one of:
 *   - `{ kind: 'exit' }`        — caller should advance to the next map
 *   - `{ kind: 'secretExit' }`  — caller should advance to the secret map
 *   - `null`                    — switch triggered a sector-tagged action
 *                                  (door/lift/crusher), or no switch was
 *                                  within range
 */
export async function tryUseSwitch(requestedBy) {
    const controller = requestedBy || player;
    const originX = controller?.x ?? player.x;
    const originY = controller?.y ?? player.y;
    const originAngle = controller === player
        ? player.angle
        : (controller?.viewAngle ?? controller?.facing ?? player.angle);

    const forwardX = -Math.sin(originAngle);
    const forwardY = Math.cos(originAngle);
    const checkPointX = originX + forwardX * USE_RANGE / 2;
    const checkPointY = originY + forwardY * USE_RANGE / 2;

    for (const wall of mapData.walls) {
        if (!wall.texture) continue;

        const isSwitchOn = wall.texture.startsWith(SWITCH_ON_PREFIX);
        const isSwitchOff = wall.texture.startsWith(SWITCH_OFF_PREFIX);
        if (!isSwitchOn && !isSwitchOff) continue;

        // Project the check-point onto the wall segment to find the closest point.
        // Uses the standard point-to-segment projection: compute parameter t along
        // the segment direction vector, clamp t to [0,1], then evaluate.
        const deltaX = wall.end.x - wall.start.x;
        const deltaY = wall.end.y - wall.start.y;
        const segmentLengthSquared = deltaX * deltaX + deltaY * deltaY;
        if (segmentLengthSquared === 0) continue;

        let projectionParameter = ((checkPointX - wall.start.x) * deltaX + (checkPointY - wall.start.y) * deltaY) / segmentLengthSquared;
        projectionParameter = Math.max(0, Math.min(1, projectionParameter));

        const closestX = wall.start.x + projectionParameter * deltaX;
        const closestY = wall.start.y + projectionParameter * deltaY;
        const distance = Math.sqrt((checkPointX - closestX) ** 2 + (checkPointY - closestY) ** 2);

        if (distance < USE_RANGE) {
            renderer.toggleSwitchState(wall.wallId);

            const linedef = mapData.linedefs[wall.linedefIndex];
            if (linedef) {
                if (linedef.specialType === EXIT_SPECIAL) {
                    return { kind: 'exit' };
                }
                if (linedef.specialType === SECRET_EXIT_SPECIAL) {
                    return { kind: 'secretExit' };
                }
                if (linedef.sectorTag > 0) {
                    for (const [sectorIndex] of state.doorState) {
                        if (mapData.sectors[sectorIndex].tag === linedef.sectorTag) {
                            await toggleDoor(sectorIndex);
                        }
                    }
                    for (const [sectorIndex, liftEntry] of state.liftState) {
                        if (liftEntry.tag === linedef.sectorTag) {
                            activateLift(sectorIndex);
                        }
                    }
                    for (const [sectorIndex] of state.crusherState) {
                        if (mapData.sectors[sectorIndex].tag === linedef.sectorTag) {
                            activateCrusher(sectorIndex);
                        }
                    }
                }
            }
            return null;
        }
    }
    return null;
}
