/**
 * World point queries (floor height, sector, hazards).
 */

import { SECTOR_DAMAGE } from '../constants.js';
import { state } from '../state.js';
import { pointInPolygon } from '../geometry.js';
import { forEachSectorAt } from '../spatial-grid.js';

function getEffectiveFloorHeight(sector) {
    const lift = state.liftState.get(sector.sectorIndex);
    return lift ? lift.currentHeight : sector.floorHeight;
}

function pointInsideSector(x, y, sector) {
    const outerBoundary = sector.boundaries[0];
    if (!outerBoundary || outerBoundary.length < 3) return false;
    if (!pointInPolygon(x, y, outerBoundary)) return false;

    for (let holeIndex = 1; holeIndex < sector.boundaries.length; holeIndex++) {
        const hole = sector.boundaries[holeIndex];
        if (hole.length >= 3 && pointInPolygon(x, y, hole)) {
            return false;
        }
    }
    return true;
}

function forEachContainingSectorAt(x, y, callback) {
    forEachSectorAt(x, y, (sector) => {
        if (!pointInsideSector(x, y, sector)) return;
        const effectiveFloor = getEffectiveFloorHeight(sector);
        callback(sector, effectiveFloor);
    });
}

/** Returns the highest effective floor at a world point. */
export function getFloorHeightAt(x, y) {
    let highestFloor = -Infinity;
    forEachContainingSectorAt(x, y, (_sector, effectiveFloor) => {
        if (effectiveFloor > highestFloor) highestFloor = effectiveFloor;
    });
    return highestFloor === -Infinity ? 0 : highestFloor;
}

/** Returns the sector at a world point, preferring the one with the highest floor. */
export function getSectorAt(x, y) {
    let best = null;
    let highestFloor = -Infinity;
    forEachContainingSectorAt(x, y, (sector, effectiveFloor) => {
        if (effectiveFloor > highestFloor) {
            highestFloor = effectiveFloor;
            best = sector;
        }
    });
    return best;
}

/** Returns hazard metadata for the sector the player is effectively standing on. */
export function getSectorHazardAt(x, y) {
    let highestFloor = -Infinity;
    let damage = 0;
    let specialType = 0;

    forEachContainingSectorAt(x, y, (sector, effectiveFloor) => {
        if (effectiveFloor > highestFloor) {
            highestFloor = effectiveFloor;
            specialType = sector.specialType;
            damage = SECTOR_DAMAGE[specialType] || 0;
        }
    });

    return { damage, specialType };
}
