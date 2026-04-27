/**
 * Visual effects — flash overlays and abstract player state classes.
 * Game logic calls these to trigger visual feedback without DOM knowledge.
 */

import { dom } from './dom.js';

/**
 * Triggers a brief screen flash by toggling a CSS class on #renderer.
 * Uses a forced reflow (void offsetWidth) to restart the animation
 * if flashes occur in rapid succession.
 */
export function triggerFlash(className, duration = 300) {
    dom.renderer.classList.remove(className);
    void dom.renderer.offsetWidth;
    dom.renderer.classList.add(className);
    setTimeout(() => dom.renderer.classList.remove(className), duration);
}

// --- Powerups ---

export function showPowerup(name) {
    dom.renderer.classList.add(`powerup-${name}`);
}

export function hidePowerup(name) {
    dom.renderer.classList.remove(`powerup-${name}`);
}

export function flickerPowerup(name, visible) {
    dom.renderer.classList.toggle(`powerup-${name}`, visible);
}

