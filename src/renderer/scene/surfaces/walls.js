/**
 * Wall element creation and scene wall construction.
 *
 * Provides both:
 * - createWallElement(): shared helper for mechanics (doors, lifts, crushers)
 *   to create individual wall DOM elements from wall data.
 * - buildWalls(): builds all scene walls from map data during scene construction.
 * - setContainerLight(): sets --light on a container from sector light level.
 *
 * Walls are positioned at their start vertex and rotated with atan2(deltaY, deltaX)
 * using CSS rotateY so they face the correct direction in 3D space.
 */

import { NO_TEXTURE, SKY_TEXTURE } from '../constants.js';

import { mapData } from '../../../data/maps.js';
import { sceneState } from '../../dom.js';
import { appendToSector, getSectorLight } from '../sectors.js';

/** Creates a wall DOM element from wall data with the given floor/ceiling heights. */
export function createWallElement(wall, floorZ, ceilZ) {
    const deltaX = wall.end.x - wall.start.x;
    const deltaY = wall.end.y - wall.start.y;
    const wallLength = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    if (wallLength < 1) return null;

    const el = document.createElement('div');
    el.className = 'wall';
    el.style.setProperty('--start-x', wall.start.x);
    el.style.setProperty('--start-y', wall.start.y);
    el.style.setProperty('--end-x', wall.end.x);
    el.style.setProperty('--end-y', wall.end.y);
    el.style.setProperty('--floor-z', floorZ);
    el.style.setProperty('--ceiling-z', ceilZ);
    el.style.backgroundImage = `url('/assets/textures/${wall.texture}.png')`;
    el.style.setProperty('--texture-offset-x', wall.xOffset);
    el.style.setProperty('--texture-offset-y', wall.yOffset);
    el.classList.add('unpegged');

    el._wall = wall;
    el._length = wallLength;
    // Unit normal (right-hand side of direction = front in DOOM):
    //   normal = (sin(wallAngle), -cos(wallAngle))
    //         = (deltaY / len,   -deltaX / len)
    el._normalX = deltaY / wallLength;
    el._normalY = -deltaX / wallLength;
    el._midX = (wall.start.x + wall.end.x) / 2;
    el._midY = (wall.start.y + wall.end.y) / 2;

    el.appendChild(document.createElement('div')).className = 'tint';

    return el;
}

/** Sets --light on a container from its sector's light level. */
export function setContainerLight(container, sectorIndex) {
    container.style.setProperty('--light', getSectorLight(sectorIndex));
}

export function buildWalls() {
    for (const wall of mapData.walls) {
        const deltaX = wall.end.x - wall.start.x;
        const deltaY = wall.end.y - wall.start.y;
        const wallLength = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        const wallHeight = wall.topHeight - wall.bottomHeight;

        if (wallLength < 1 || wallHeight < 1) continue;

        // Skip lower walls on lift sector boundaries — shaft walls created
        // by initLifts() cover this geometry with the correct height span
        if (wall.isLiftWall) continue;

        // Skip untextured walls — in DOOM, texture name "-" or empty means transparent/passable
        const textureName = wall.texture;
        if (!textureName || textureName === NO_TEXTURE || textureName === '') continue;

        const isSwitch = textureName.startsWith('SW1') || textureName.startsWith('SW2');
        const wallElement = document.createElement(isSwitch ? 'button' : 'div');
        wallElement.className = 'wall' + (wall.isScrolling ? ' scroll-texture' : '');
        if (wall.wallId) wallElement.id = wall.wallId;
        if (isSwitch) wallElement.classList.add('switch');

        // Pass raw DOOM coordinates — CSS computes width, height, position, rotation
        wallElement.style.setProperty('--start-x', wall.start.x);
        wallElement.style.setProperty('--start-y', wall.start.y);
        wallElement.style.setProperty('--end-x', wall.end.x);
        wallElement.style.setProperty('--end-y', wall.end.y);
        wallElement.style.setProperty('--floor-z', wall.bottomHeight);
        wallElement.style.setProperty('--ceiling-z', wall.topHeight);

        wallElement.dataset.texture = textureName;
        wallElement.style.backgroundImage = `url('/assets/textures/${textureName}.png')`;
        wallElement.style.setProperty('--texture-offset-x', wall.xOffset);
        wallElement.style.setProperty('--texture-offset-y', wall.yOffset);

        const centerX = (wall.start.x + wall.end.x) / 2;
        const centerY = (wall.start.y + wall.end.y) / 2;
        wallElement._midX = centerX;
        wallElement._midY = centerY;
        wallElement._wall = wall;
        wallElement._length = wallLength;
        // Unit normal (right-hand side = front in DOOM).
        wallElement._normalX = deltaY / wallLength;
        wallElement._normalY = -deltaX / wallLength;
        wallElement._sectorIndex = wall.sectorIndex;

        wallElement.appendChild(document.createElement('div')).className = 'tint';

        wallElement.classList.add('culled');
        appendToSector(wallElement, wall.sectorIndex);
        sceneState.wallElements.push(wallElement);
    }

    buildSkyWalls();
}

/**
 * Populates `sceneState.skyWallPlanes` — 2D occluder segments on the perimeter
 * of sky-ceiling sectors. The culler (behindSkyWall) uses these to hide scene
 * elements behind sky boundaries, approximating DOOM's sky-as-opaque-backdrop.
 */
function buildSkyWalls() {
    const sectors = mapData.sectors;
    if (!sectors) return;

    const skyIndices = new Set();
    for (let i = 0; i < sectors.length; i++) {
        if (sectors[i].ceilingTexture === SKY_TEXTURE) skyIndices.add(i);
    }
    if (skyIndices.size === 0) return;

    sceneState.skySectors = skyIndices;

    // Build a lookup: linedef index → [frontSector, backSector]
    const linedefSectors = new Map();
    if (mapData.linedefs && mapData.sidedefs) {
        for (let i = 0; i < mapData.linedefs.length; i++) {
            const ld = mapData.linedefs[i];
            const front = mapData.sidedefs[ld.frontSidedef].sectorIndex;
            const back = ld.backSidedef >= 0 ? mapData.sidedefs[ld.backSidedef].sectorIndex : null;
            linedefSectors.set(i, { front, back });
        }
    }

    // Compute connected groups of sky sectors. Sectors in the same group
    // share boundaries and form one contiguous sky area. Sky walls should
    // not cull elements that belong to the same sky group — those elements
    // are the visible perimeter of the same outdoor area.
    const skyGroupOf = new Map(); // sectorIndex → group ID
    let groupId = 0;
    const adj = new Map();
    for (const s of skyIndices) adj.set(s, new Set());
    for (const wall of mapData.walls) {
        const ld = linedefSectors.get(wall.linedefIndex);
        if (!ld) continue;
        const { front, back } = ld;
        if (back !== null && skyIndices.has(front) && skyIndices.has(back)) {
            adj.get(front).add(back);
            adj.get(back).add(front);
        }
    }
    for (const s of skyIndices) {
        if (skyGroupOf.has(s)) continue;
        const stack = [s];
        while (stack.length) {
            const n = stack.pop();
            if (skyGroupOf.has(n)) continue;
            skyGroupOf.set(n, groupId);
            for (const neighbor of adj.get(n)) {
                if (!skyGroupOf.has(neighbor)) stack.push(neighbor);
            }
        }
        groupId++;
    }
    sceneState.skyGroupOf = skyGroupOf;

    for (const wall of mapData.walls) {
        if (!skyIndices.has(wall.sectorIndex)) continue;

        // Skip walls between two sky sectors — no occlusion needed there.
        // Keep one-sided perimeter walls (far edges) and two-sided boundary
        // walls between sky and non-sky (above window openings).
        const ld = linedefSectors.get(wall.linedefIndex);
        if (!ld) continue;
        const otherSector = ld.front === wall.sectorIndex ? ld.back : ld.front;
        if (otherSector !== null && skyIndices.has(otherSector)) continue;

        // Occluder floor height. For boundary walls (two-sided sky/non-sky),
        // elements below the sky sector's ceiling height could be visible
        // through the upper-wall opening, so the occluder starts there.
        // For perimeter walls (one-sided), start at the wall top.
        const skyFloor = otherSector !== null
            ? sectors[wall.sectorIndex].ceilingHeight
            : wall.topHeight;

        const dx = wall.end.x - wall.start.x;
        const dy = wall.end.y - wall.start.y;
        const wallAngle = Math.atan2(dy, dx);
        const nx = Math.sin(wallAngle);
        const ny = -Math.cos(wallAngle);
        sceneState.skyWallPlanes.push({
            nx, ny,
            px: wall.start.x, py: wall.start.y,
            ax: wall.start.x, ay: wall.start.y,
            bx: wall.end.x, by: wall.end.y,
            floorZ: skyFloor,
            sectorIndex: wall.sectorIndex,
            skyGroup: skyGroupOf.get(wall.sectorIndex),
        });
    }
}
