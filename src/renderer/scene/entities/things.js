/**
 * Thing (entity) construction from map data.
 *
 * Creates DOM elements for enemies, pickups, barrels, and decorations.
 * Enemies get AI state initialized from ENEMY_AI_STATS constants.
 * Nightmare skill level doubles speeds and halves timings.
 */

import { THING_SPRITES, THING_NAMES } from '../constants.js';
import { THING_CATEGORY } from '../../../data/things.js';

import { state } from '../../../game/state.js';
import { spawnThings } from '../../../game/things/spawner.js';
import { mapData } from '../../../data/maps.js';
import { sceneState } from '../../dom.js';
import { getFloorHeightAt, getSectorAt } from '../../../game/physics/queries.js';
import { appendToSector } from '../sectors.js';

export function buildThings() {
    if (!mapData.things) return;

    // Game entries are registered by `spawnThings()` (headless spawner).
    // If we're called before a spawn pass has run (legacy single-player path),
    // run it now so the DOM builder can always read a pre-built mapping.
    let mapThingToIndex = mapData._thingIndexByMapIdx;
    if (!mapThingToIndex) {
        spawnThings();
        mapThingToIndex = mapData._thingIndexByMapIdx;
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

        thingContainer.hidden = true;
        appendToSector(thingContainer, sector?.sectorIndex);

        const thingIndex = mapThingToIndex[mapIdx];
        if (thingIndex !== null && thingIndex !== undefined) {
            sceneState.thingDom.set(thingIndex, { element: thingContainer, sprite: spriteElement });
            sceneState.thingContainers.push({ element: thingContainer, x: thing.x, y: thing.y, gameId: thingIndex });
        } else {
            sceneState.thingContainers.push({ element: thingContainer, x: thing.x, y: thing.y });
        }
    }
}
