/**
 * Sector containers and light effects.
 *
 * Each sector gets a container div that groups all geometry (walls, floors,
 * ceilings, things) belonging to that sector. The CSS custom property --light
 * is set once on the container and inherited by all children.
 */

import { LIGHT_MINIMUM_BRIGHTNESS, DOOM_LIGHT_MAX, LIGHT_DISTANCE_OFFSET } from './constants.js';

import { mapData } from '../../data/maps.js';
import { dom, sceneState } from '../dom.js';

/**
 * Maps DOOM sector special types to CSS animation classes for dynamic lighting effects.
 * These classes trigger flickering, glowing, or blinking animations in the stylesheet.
 */
const LIGHT_EFFECT_CLASS = {
    1: 'light-flicker',       // blink random
    2: 'light-blink-fast',    // blink 0.5s
    3: 'light-blink',         // blink 1.0s
    8: 'light-glow',          // oscillate
    12: 'light-blink-fast',   // blink 0.5s sync
    13: 'light-blink',        // blink 1.0s sync
    17: 'light-fire-flicker', // fire flicker
};

function applyLightEffect(element, specialType) {
    const className = LIGHT_EFFECT_CLASS[specialType];
    if (!className) return;
    element.classList.add(className);
}

/**
 * Converts a DOOM sector light level (0–255) to a CSS --light value (0–1).
 * Based on DOOM's R_InitLightTables: lightnum = lightLevel/16 selects from
 * 32 colormaps. LIGHT_DISTANCE_OFFSET compensates for DOOM's scalelight
 * close-range brightening effect.
 */
function doomLightToCSS(lightLevel) {
    const startmap = (15 - lightLevel / 16) * 4 - LIGHT_DISTANCE_OFFSET;
    const colormap = Math.max(0, Math.min(31, startmap));
    return Math.max(LIGHT_MINIMUM_BRIGHTNESS, 1 - colormap / 32);
}

export function buildSectorContainers() {
    const sectors = mapData.sectors;
    if (!sectors) return;

    for (let i = 0; i < sectors.length; i++) {
        const sector = sectors[i];
        const container = document.createElement('div');
        container.className = 'sector';
        container.id = `s${i}`;

        container.style.setProperty('--light',
            doomLightToCSS(sector.lightLevel));

        if (sector.specialType) {
            applyLightEffect(container, sector.specialType);
        }

        dom.scene.appendChild(container);
        sceneState.sectorContainers.push(container);
    }
}

/** Converts a DOOM sector's light level to a CSS --light value (0–1). */
export function getSectorLight(sectorIndex) {
    const sectorData = mapData.sectors?.[sectorIndex];
    if (!sectorData) return 1;
    return doomLightToCSS(sectorData.lightLevel);
}

export function appendToSector(element, sectorIndex) {
    if (sectorIndex !== undefined && sceneState.sectorContainers[sectorIndex]) {
        sceneState.sectorContainers[sectorIndex].appendChild(element);
    } else {
        dom.scene.appendChild(element);
    }
}
