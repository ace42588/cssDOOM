/**
 * Sound propagation — sector-based BFS flood when the player fires.
 *
 * Based on: linuxdoom-1.10/p_enemy.c:P_RecursiveSound()
 * When the player fires a weapon, sound floods outward through connected
 * sectors via two-sided linedefs. Enemies in reached sectors wake up.
 *
 * Sound is blocked by linedefs with ML_SOUNDBLOCK (flag 0x40). Sound can
 * pass through ONE sound-blocking line, but stops at a second — matching
 * DOOM's `soundtraversed` counter (0 = unvisited, 1 = reached openly,
 * 2 = reached through one block).
 */

import { mapData } from '../data/maps.js';
import { getSectorAt } from './physics/queries.js';
import { player, state } from './state.js';

const ML_SOUNDBLOCK = 0x40;

// Sector adjacency: Map<sectorIndex, Array<{ sector: number, soundBlock: boolean, linedefIndex: number }>>
let adjacency = null;

// Door data lookup: Map<sectorIndex, doorData>
let doorDataMap = null;

// Set of sector indices that heard the last gunshot
let alertedSectors = new Set();

/**
 * Builds the sector adjacency graph from the current map's linedefs/sidedefs.
 * Called once per map load.
 */
export function buildSectorAdjacency() {
    adjacency = new Map();
    alertedSectors.clear();

    // Build door lookup for P_LineOpening checks
    doorDataMap = new Map();
    if (mapData.doors) {
        for (const door of mapData.doors) {
            doorDataMap.set(door.sectorIndex, door);
        }
    }

    const linedefs = mapData.linedefs;
    const sidedefs = mapData.sidedefs;

    for (let i = 0; i < linedefs.length; i++) {
        const ld = linedefs[i];
        if (ld.backSidedef === -1) continue; // one-sided, skip

        const frontSector = sidedefs[ld.frontSidedef].sectorIndex;
        const backSector = sidedefs[ld.backSidedef].sectorIndex;
        if (frontSector === backSector) continue;

        const soundBlock = (ld.flags & ML_SOUNDBLOCK) !== 0;

        if (!adjacency.has(frontSector)) adjacency.set(frontSector, []);
        if (!adjacency.has(backSector)) adjacency.set(backSector, []);

        adjacency.get(frontSector).push({ sector: backSector, soundBlock, linedefIndex: i });
        adjacency.get(backSector).push({ sector: frontSector, soundBlock, linedefIndex: i });
    }
}

/**
 * Computes the vertical opening of a two-sided linedef, accounting for door state.
 * Based on: linuxdoom-1.10/p_sight.c:P_LineOpening()
 */
function getLineOpening(linedefIndex) {
    const ld = mapData.linedefs[linedefIndex];
    const frontSectorIdx = mapData.sidedefs[ld.frontSidedef].sectorIndex;
    const backSectorIdx = mapData.sidedefs[ld.backSidedef].sectorIndex;
    return getSectorOpening(frontSectorIdx, backSectorIdx);
}

/**
 * Computes the vertical opening between two adjacent sectors, accounting
 * for door state. Same math as P_LineOpening but indexed directly by the
 * two sectors on either side of the portal — used by the renderer's
 * portal flood (PVS) where portals are derived from sector-polygon edges
 * and no linedef index is available.
 *
 * Returns a height in DOOM units. A value <= 0 means the portal is closed
 * (fully raised lift, closed door, crushing ceiling). If the door-data
 * map hasn't been populated yet (first cull pass of a fresh load), falls
 * back to raw sector heights.
 *
 * `includeVisualClosing: true` keeps a recently-closing door "open" until
 * its close animation finishes, so renderer PVS does not hide sectors while
 * the doorway is still visibly open.
 */
export function getSectorOpening(frontSectorIdx, backSectorIdx, options = {}) {
    const { includeVisualClosing = false } = options;
    const fs = mapData.sectors[frontSectorIdx];
    const bs = mapData.sectors[backSectorIdx];
    if (!fs || !bs) return 0;

    let frontCeil = fs.ceilingHeight;
    let backCeil = bs.ceilingHeight;

    // If either sector is a door, use its open height when open, closed height when closed
    if (doorDataMap) {
        const now = includeVisualClosing ? Date.now() : 0;
        const frontDoor = doorDataMap.get(frontSectorIdx);
        if (frontDoor) {
            const doorState = state.doorState.get(frontSectorIdx);
            const visuallyOpen = doorState?.open || (includeVisualClosing && doorState?.closingUntil > now);
            frontCeil = visuallyOpen ? frontDoor.openHeight : frontDoor.closedHeight;
        }
        const backDoor = doorDataMap.get(backSectorIdx);
        if (backDoor) {
            const doorState = state.doorState.get(backSectorIdx);
            const visuallyOpen = doorState?.open || (includeVisualClosing && doorState?.closingUntil > now);
            backCeil = visuallyOpen ? backDoor.openHeight : backDoor.closedHeight;
        }
    }

    const openTop = Math.min(frontCeil, backCeil);
    const openBottom = Math.max(fs.floorHeight, bs.floorHeight);
    return openTop - openBottom;
}

/**
 * Floods sound from the player's current position through connected sectors.
 * Marks all reachable sectors so enemies can check via `isSectorAlerted()`.
 *
 * Based on: linuxdoom-1.10/p_enemy.c:P_RecursiveSound()
 * Uses BFS instead of recursion. The `soundtraversed` counter allows sound
 * to pass through at most one ML_SOUNDBLOCK line.
 */
export function propagateSound() {
    alertedSectors.clear();
    if (!adjacency) return;

    const playerSector = getSectorAt(player.x, player.y);
    if (!playerSector) return;

    const startIndex = playerSector.sectorIndex;

    // BFS queue: [sectorIndex, blocksEncountered]
    // blocksEncountered: 0 = direct, 1 = passed through one sound-block line
    const queue = [[startIndex, 0]];

    // Track visited with the minimum blocks used to reach each sector
    // (a sector reached with 0 blocks shouldn't be re-queued with 1 block)
    const visited = new Map(); // sectorIndex → minimum blocksEncountered
    visited.set(startIndex, 0);
    alertedSectors.add(startIndex);

    while (queue.length > 0) {
        const [currentSector, blocks] = queue.shift();
        const neighbors = adjacency.get(currentSector);
        if (!neighbors) continue;

        for (let i = 0; i < neighbors.length; i++) {
            const { sector: neighborSector, soundBlock, linedefIndex } = neighbors[i];

            // Check if linedef is passable (closed doors have zero opening)
            // Based on: linuxdoom-1.10/p_enemy.c:P_RecursiveSound() — skips if openrange <= 0
            if (getLineOpening(linedefIndex) <= 0) continue;

            const newBlocks = blocks + (soundBlock ? 1 : 0);

            // Sound stops after passing through 2 sound-blocking lines
            if (newBlocks > 1) continue;

            // Only visit if we haven't reached this sector with fewer blocks
            const prevBlocks = visited.get(neighborSector);
            if (prevBlocks !== undefined && prevBlocks <= newBlocks) continue;

            visited.set(neighborSector, newBlocks);
            alertedSectors.add(neighborSector);
            queue.push([neighborSector, newBlocks]);
        }
    }
}

/**
 * Returns true if the given sector index was reached by the last sound propagation.
 */
export function isSectorAlerted(sectorIndex) {
    return alertedSectors.has(sectorIndex);
}

/**
 * Clears the alerted sectors (called on map clear/reset).
 */
export function clearSoundAlert() {
    alertedSectors.clear();
    adjacency = null;
    doorDataMap = null;
}
