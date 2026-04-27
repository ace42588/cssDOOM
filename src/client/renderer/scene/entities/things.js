/**
 * Thing (entity) construction from map data.
 *
 * Creates DOM elements for enemies, pickups, barrels, and decorations.
 * Enemies get AI state initialized from ENEMY_AI_STATS constants.
 * Nightmare skill level doubles speeds and halves timings.
 */

import { THING_SPRITES, THING_NAMES } from '../constants.js';
import { THING_CATEGORY } from '../../../../engine/data/things.js';

import { state } from '../../../../engine/state.js';
import { mapData } from '../../../../engine/data/maps.js';
import { sceneState } from '../../dom.js';
import { getFloorHeightAt, getSectorAt } from '../../../../engine/physics/queries.js';
import { appendToSector } from '../sectors.js';

export function buildThings() {
    if (!mapData.things) return;

    // `mapData._thingIndexByMapIdx` is produced by `spawnThings()` before the
    // scene build (browser: index.js applyServerMap; server: loadMapHeadless).
    const mapThingToIndex = mapData._thingIndexByMapIdx;
    if (!mapThingToIndex) {
        throw new Error(
            'buildThings: spawnThings() must run before buildThings() so thing indices match snapshots.',
        );
    }

    for (let mapIdx = 0; mapIdx < mapData.things.length; mapIdx++) {
        const thing = mapData.things[mapIdx];
        if (thing.flags & 16) continue;
        const skillBit = state.skillLevel <= 2 ? 1 : state.skillLevel === 3 ? 2 : 4;
        if (!(thing.flags & skillBit)) continue;

        const thingName = THING_NAMES[thing.type];
        const staticSprite = THING_SPRITES[thing.type];
        if (!thingName && !staticSprite) continue;

        const floorHeight = getFloorHeightAt(thing.x, thing.y);

        const thingContainer = document.createElement('div');
        const category = THING_CATEGORY[thing.type] ?? 'decoration';
        thingContainer.className = category;
        thingContainer.style.setProperty('--x', thing.x);
        thingContainer.style.setProperty('--floor-z', floorHeight);
        thingContainer.style.setProperty('--y', thing.y);
        const sector = getSectorAt(thing.x, thing.y);

        let spriteElement = null;
        if (thingName) {
            spriteElement = document.createElement('div');
            spriteElement.className = 'sprite';
            spriteElement.dataset.type = thingName;
            spriteElement.style.animationDelay = `-${Math.random() * 2}s`;
            thingContainer.appendChild(spriteElement);
        } else {
            const imageElement = document.createElement('img');
            imageElement.src = `/assets/sprites/${staticSprite}.png`;
            imageElement.draggable = false;
            thingContainer.appendChild(imageElement);
        }

        thingContainer.classList.add('culled');
        const sectorIndex = sector?.sectorIndex;
        // Stamped on the DOM element so reparentThingToSector keeps it in
        // sync as moving things cross sector boundaries; the PVS culling
        // pass reads from here.
        thingContainer._sectorIndex = sectorIndex;
        appendToSector(thingContainer, sectorIndex);

        const thingIndex = mapThingToIndex[mapIdx];
        if (thingIndex !== null && thingIndex !== undefined) {
            sceneState.thingDom.set(thingIndex, { element: thingContainer, sprite: spriteElement });
            // Movable entries: cull pass reads live `state.things[gameId].x/y`
            // each frame, so no spawn-time x/y is stored here. See the
            // `culling.js` thing-cull loop for why.
            sceneState.thingContainers.push({ element: thingContainer, gameId: thingIndex });
        } else {
            // Static entries (decorations the spawner skipped): never move,
            // so cache spawn coords for the cull pass to read directly.
            sceneState.thingContainers.push({ element: thingContainer, x: thing.x, y: thing.y });
        }
    }
}
