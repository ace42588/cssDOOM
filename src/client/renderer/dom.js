/**
 * Cached DOM element references and renderer-specific state.
 *
 * Fixed HTML elements that never change after page load,
 * shared across renderer modules to avoid repeated lookups.
 */

export const dom = {
    renderer: document.getElementById('renderer'),
    scene: document.getElementById('scene'),
    viewport: document.getElementById('viewport'),
    menuButton: document.getElementById('menu-button'),
    menuOverlay: document.getElementById('menu-overlay'),
    status: document.getElementById('status'),
    weaponElement: document.getElementById('weapon'),
    ammoPanel: document.getElementById('ammo-panel'),
};

/**
 * Renderer-specific state — arrays of DOM elements representing the 3D scene.
 * Rebuilt each map load. Game logic should not access these.
 */
export const sceneState = {
    wallElements: [],
    surfaceElements: [],
    sectorContainers: [],
    thingContainers: [],
    doorContainers: new Map(),
    liftContainers: new Map(),
    crusherContainers: new Map(),
    skyWallPlanes: [],             // Array of { nx, ny, px, py, ax, ay, bx, by } — sky wall occluders
    skySectors: new Set(),         // Sector indices with sky ceilings
    skyGroupOf: new Map(),         // Map<sectorIndex, groupId> — connected sky sector groups
    thingDom: new Map(),          // Map<thingIndex, { element, sprite }>
    projectileDom: new Map(),     // Map<projectileId, element>
    // CSS perspective distance in pixels. Determines the field of view;
    // also used as a translateZ offset to position the camera correctly.
    perspectiveValue: 700,
};
