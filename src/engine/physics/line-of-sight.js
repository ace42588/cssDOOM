/**
 * 3D line-of-sight check using DOOM's slope-narrowing algorithm.
 * Based on: linuxdoom-1.10/p_sight.c:P_CheckSight(), P_CrossSubsector()
 */

import { EYE_HEIGHT } from '../constants.js';
import { state } from '../state.js';
import { getDeltas, rayHitsSegment } from '../geometry.js';
import { forEachWallInAABB, forEachSightLineInAABB } from '../spatial-grid.js';
import { isDoorClosed } from '../mechanics/doors.js';
import { getFloorHeightAt } from './queries.js';

/**
 * @param {{ x: number, y: number }} from
 * @param {{ x: number, y: number }} to
 */
export function hasLineOfSight(from, to) {
    const fromX = from.x;
    const fromY = from.y;
    const toX = to.x;
    const toY = to.y;

    const { deltaX, deltaY } = getDeltas(from, to);
    const distance = Math.hypot(deltaX, deltaY);
    if (distance < 1) return true;

    const dirX = deltaX / distance;
    const dirY = deltaY / distance;

    const minX = Math.min(fromX, toX), maxX = Math.max(fromX, toX);
    const minY = Math.min(fromY, toY), maxY = Math.max(fromY, toY);

    let wallBlocked = false;
    forEachWallInAABB(minX, minY, maxX, maxY, wall => {
        if (wall.isUpperWall || wall.isLowerWall || wall.isMiddleWall) return;
        if (!wall.isSolid && !isDoorClosed(wall)) return;
        if (rayHitsSegment(fromX, fromY, dirX, dirY,
            wall.start.x, wall.start.y, wall.end.x, wall.end.y, distance)) {
            wallBlocked = true;
            return false;
        }
    });
    if (wallBlocked) return false;

    const fromZ = getFloorHeightAt(fromX, fromY) + EYE_HEIGHT;
    const toZ = getFloorHeightAt(toX, toY) + EYE_HEIGHT;
    let topSlope = (toZ + EYE_HEIGHT) - fromZ;
    let bottomSlope = (toZ - EYE_HEIGHT) - fromZ;

    let sightBlocked = false;
    forEachSightLineInAABB(minX, minY, maxX, maxY, line => {
        const segDx = line.end.x - line.start.x;
        const segDy = line.end.y - line.start.y;
        const cross = dirX * segDy - dirY * segDx;
        if (Math.abs(cross) < 1e-8) return;

        const t = ((line.start.x - fromX) * segDy - (line.start.y - fromY) * segDx) / cross;
        if (t <= 0 || t >= distance) return;
        const u = ((line.start.x - fromX) * dirY - (line.start.y - fromY) * dirX) / cross;
        if (u < 0 || u > 1) return;

        let openBottom = line.openBottom;
        let openTop = line.openTop;

        if (state.doorState) {
            const frontDoor = state.doorState.get(line.frontSector);
            const backDoor = state.doorState.get(line.backSector);
            if (frontDoor && frontDoor.open) openTop = Math.max(openTop, frontDoor.openHeight);
            if (backDoor && backDoor.open) openTop = Math.max(openTop, backDoor.openHeight);
        }

        if (state.liftState) {
            const frontLift = state.liftState.get(line.frontSector);
            const backLift = state.liftState.get(line.backSector);
            if (frontLift) openBottom = Math.max(openBottom, frontLift.currentHeight);
            if (backLift) openBottom = Math.max(openBottom, backLift.currentHeight);
        }

        if (openBottom >= openTop) { sightBlocked = true; return false; }

        if (openBottom > fromZ) {
            const slope = (openBottom - fromZ) / t;
            if (slope > bottomSlope) bottomSlope = slope;
        }
        if (openTop < fromZ) {
            const slope = (openTop - fromZ) / t;
            if (slope < topSlope) topSlope = slope;
        }

        if (topSlope <= bottomSlope) { sightBlocked = true; return false; }
    });

    return !sightBlocked;
}
