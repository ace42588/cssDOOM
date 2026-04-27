/**
 * Renderer constants — visual thresholds, DOOM-to-CSS conversion values,
 * texture identifiers, and sprite lookup tables.
 */

import {
    THING_SPRITES as SHARED_THING_SPRITES,
    THING_NAMES as SHARED_THING_NAMES,
} from '../../data/things.js';

// ============================================================================
// Lighting
// ============================================================================

// Floors of even the darkest sectors never go fully black — a small minimum
// keeps geometry visible and avoids "invisible wall" surprises.
export const LIGHT_MINIMUM_BRIGHTNESS = 0.12;

// DOOM's R_InitLightTables maps sector lightlevel to colormaps (0=bright, 31=black).
// The formula: startmap = (15 - lightLevel/16) * 4, offset by a medium-distance
// brightening factor to approximate DOOM's scalelight close-range boost.
export const LIGHT_DISTANCE_OFFSET = 4;   // Medium-distance scalelight compensation

// ============================================================================
// Sky & Special Textures
// ============================================================================

export const SKY_TEXTURE = 'F_SKY1';       // DOOM flat name used on sky ceilings/floors
export const NO_TEXTURE = '-';             // DOOM's marker meaning "no texture on this sidedef"

// ============================================================================
// Thing Sprites
// Maps DOOM thing-type numbers to the sprite lump name (without .png) used
// as the visual representation. Frame letter "A" = first frame; rotation
// digit "1" = front-facing, "0" = rotation-independent.
// ============================================================================

export const THING_SPRITES = SHARED_THING_SPRITES;

// ============================================================================
// Thing Display Names
// Maps thing-type numbers to kebab-case names used as CSS class selectors
// in sprites.css for animation and styling.
// ============================================================================

export const THING_NAMES = SHARED_THING_NAMES;
