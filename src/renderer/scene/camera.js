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

import { player } from '../../game/state.js';
import { getControlled, getControlledEye } from '../../game/possession.js';
import { getRenderedPlayerPose } from '../../net/client.js';
import { dom } from '../dom.js';

/**
 * Pushes the current view position and viewing angle to CSS custom
 * properties on the viewport element. The CSS transform on #scene reads
 * these properties to compute the inverse camera transform each frame.
 *
 * With body-swap, the "view" tracks whichever actor is currently under
 * user control — the normal player character or a possessed monster.
 *
 * Multiplayer: the marine (`player`) has its own world position/angle
 * independent of the viewer's eye. We expose `--marine-*` vars so the
 * third-person `#player` sprite can be drawn at the marine's real world
 * location whenever the local viewer isn't the marine themselves.
 */
// Cache the last value pushed for each CSS custom property so identical
// frame-to-frame writes (camera held still, marine offscreen, etc.) become
// no-ops instead of forcing the browser to recompute style on `#viewport`.
const lastCameraVar = {
    px: NaN, py: NaN, pz: NaN, pf: NaN, pa: NaN,
    mx: NaN, my: NaN, mf: NaN, ma: NaN,
    sa: NaN, ca: NaN, cfx: NaN, cfy: NaN,
};
let lastShowMarine = null;

function setVarIfChanged(style, name, value, key) {
    if (lastCameraVar[key] !== value) {
        lastCameraVar[key] = value;
        style.setProperty(name, value);
    }
}

export function updateCamera() {
    const viewportStyle = dom.viewport.style;
    const eye = getControlledEye();

    setVarIfChanged(viewportStyle, '--player-x', eye.x, 'px');
    setVarIfChanged(viewportStyle, '--player-y', eye.y, 'py');
    setVarIfChanged(viewportStyle, '--player-z', eye.z, 'pz');
    setVarIfChanged(viewportStyle, '--player-floor', eye.floorHeight || 0, 'pf');
    setVarIfChanged(viewportStyle, '--player-angle', eye.angle, 'pa');

    // Precompute camera trig once per frame so CSS consumers (lighting,
    // frustum culling, spectator follow cam) and every culled element can
    // read scalar dot-product inputs instead of re-evaluating sin/cos.
    const sa = Math.sin(eye.angle);
    const ca = Math.cos(eye.angle);
    setVarIfChanged(viewportStyle, '--sin-angle', sa, 'sa');
    setVarIfChanged(viewportStyle, '--cos-angle', ca, 'ca');
    setVarIfChanged(viewportStyle, '--camera-forward-x', -sa, 'cfx');
    setVarIfChanged(viewportStyle, '--camera-forward-y', ca, 'cfy');

    const marine = getRenderedPlayerPose();
    setVarIfChanged(viewportStyle, '--marine-x', marine.x, 'mx');
    setVarIfChanged(viewportStyle, '--marine-y', marine.y, 'my');
    setVarIfChanged(viewportStyle, '--marine-floor', marine.floor || 0, 'mf');
    setVarIfChanged(viewportStyle, '--marine-angle', marine.angle, 'ma');

    const showMarine = getControlled() !== player && !player.isDead;
    if (showMarine !== lastShowMarine) {
        lastShowMarine = showMarine;
        document.body.classList.toggle('show-marine', showMarine);
    }

    const marker = document.querySelector('#player > .marker');
    if (marker) {
        marker.classList.toggle('firing', player.isFiring);
    }

    if (showMarine) {
        updateMarineSpriteHeading(eye);
    }
}

/**
 * Pick the DOOM rotation row (0..4 + mirror) for the marine sprite based
 * on where the viewer's eye sits relative to the marine's facing. Mirrors
 * the enemy-rotation formula in `src/renderer/scene/entities/sprites.js`
 * so the marine looks consistent with every other actor in the world.
 */
let lastMarineHeading = -1;
let lastMarineMirror = -1;

function updateMarineSpriteHeading(eye) {
    const sprite = document.querySelector('#player > .sprite');
    if (!sprite) return;

    const marine = getRenderedPlayerPose();
    const angleToViewer = Math.atan2(eye.y - marine.y, eye.x - marine.x);
    // Enemy convention: `facing = viewAngle + PI/2`. Apply the same offset
    // so the marine's sheet indexing matches the enemy renderer.
    const marineFacing = marine.angle + Math.PI / 2;
    let rel = angleToViewer - marineFacing;
    rel = ((rel % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const rotationIndex = (Math.floor((rel + Math.PI / 8) / (Math.PI / 4)) % 8) + 1;

    let sheetRow, mirrorScale;
    if (rotationIndex <= 5) {
        sheetRow = rotationIndex - 1;
        mirrorScale = 1;
    } else {
        sheetRow = 9 - rotationIndex;
        mirrorScale = -1;
    }

    if (sheetRow !== lastMarineHeading || mirrorScale !== lastMarineMirror) {
        lastMarineHeading = sheetRow;
        lastMarineMirror = mirrorScale;
        sprite.style.setProperty('--heading', sheetRow);
        sprite.style.setProperty('--mirror', mirrorScale);
    }
}
