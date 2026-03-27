/**
 * Camera Module — Updates the CSS 3D camera transform.
 *
 * CSS has no native "camera" concept. To simulate one, we apply an inverse
 * transform to the entire scene container (#scene). Instead of moving a camera
 * forward, we move the whole world backward. Instead of rotating the camera
 * right, we rotate the whole world left. This is the standard trick for
 * first-person 3D in CSS.
 *
 * The scene transform chain (defined in style.css) is:
 *
 *   1. translateZ(var(--perspective))
 *      CSS `perspective` places the viewer at z = +perspective relative to the
 *      element's plane (z = 0). This initial translateZ pushes the scene
 *      forward by exactly the perspective distance, effectively moving the
 *      scene's origin to the viewer's eye. Without this offset, the world
 *      would appear too far away, because the perspective vanishing point
 *      would be at the wrong depth.
 *
 *   2. rotateY(calc(var(--player-angle) * -1rad))
 *      Applies the inverse of the player's yaw rotation. The negation is key:
 *      when the player looks right (+angle), the world rotates left (-angle).
 *
 *   3. translate3d(-playerX, +playerZ, +playerY)
 *      Applies the inverse of the player's position. Negating X and using the
 *      DOOM-to-CSS coordinate mapping:
 *        - DOOM X (east/west)   → CSS X axis (negate for inverse)
 *        - DOOM Y (north/south) → CSS -Z axis (positive here because inverse)
 *        - DOOM Z (height)      → CSS -Y axis (positive here because CSS Y
 *          points down, but the state already stores the negated value)
 *
 * This module passes the player's position and angle to CSS as custom
 * properties (--player-x, --player-y, --player-z, --player-angle), and CSS
 * handles the actual transform composition. This keeps the math in CSS where
 * the browser can optimize transitions (e.g., the falling ease-out on
 * --player-z) and avoids JavaScript reflow overhead.
 */

import { state } from '../../game/state.js';
import { dom } from '../dom.js';

/**
 * Pushes the current player position and viewing angle to CSS custom
 * properties on the viewport element. The CSS transform on #scene reads
 * these properties to compute the inverse camera transform each frame.
 */
export function updateCamera() {
    const viewportStyle = dom.viewport.style;

    // Horizontal position along the east-west axis
    viewportStyle.setProperty('--player-x', state.playerX);

    // Horizontal position along the north-south axis
    viewportStyle.setProperty('--player-y', state.playerY);

    // Vertical position / height
    viewportStyle.setProperty('--player-z', state.playerZ);

    // Floor height at player position
    viewportStyle.setProperty('--player-floor', state.floorHeight || 0);

    // Viewing angle in radians (0 = north, increasing clockwise)
    viewportStyle.setProperty('--player-angle', state.playerAngle);

    // Toggle firing class on player marker for spectator mode visual feedback
    const marker = document.querySelector('#player > .marker');
    if (marker) {
        marker.classList.toggle('firing', state.isFiring);
    }
}
