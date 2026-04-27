/**
 * Camera Module — Updates the CSS 3D camera transform.
 *
 * CSS has no native "camera" concept. To simulate one, we apply an inverse
 * transform to the entire scene container (#scene). Instead of moving a camera
 * forward, we move the whole world backward. Instead of rotating the camera
 * right, we rotate the whole world left. This is the standard trick for
 * first-person 3D in CSS.
 *
 * The scene transform chain (defined in camera.css) is:
 *
 *   1. translateZ(var(--perspective))
 *      CSS `perspective` places the viewer at z = +perspective relative to the
 *      element's plane (z = 0). This initial translateZ pushes the scene
 *      forward by exactly the perspective distance, effectively moving the
 *      scene's origin to the viewer's eye. Without this offset, the world
 *      would appear too far away, because the perspective vanishing point
 *      would be at the wrong depth.
 *
 *   2. rotateY(calc(var(--view-angle) * -1rad))
 *      Applies the inverse of the session's view yaw rotation.
 *
 *   3. translate3d(-viewX, +viewZ, +viewY)
 *      Applies the inverse of the session's view position.
 *
 * This module pushes the view pose for the local session into CSS custom
 * properties (--view-x, --view-y, --view-z, --view-angle). "View" here means
 * whichever actor the local session currently controls — the marine or a
 * possessed monster. Per-actor world pose (for the marine's third-person
 * billboard) lives in --avatar-* on the actor's own DOM node.
 */

import { getMarineActor } from '../../game/state.js';
import { LOCAL_SESSION, getControlled, getControlledEye } from '../../game/possession.js';
import { getRenderedPlayerPose } from '../../net/client.js';
import { dom } from '../dom.js';

const lastCameraVar = {
    vx: NaN, vy: NaN, vz: NaN, vf: NaN, va: NaN,
    ax: NaN, ay: NaN, af: NaN, aa: NaN,
    sa: NaN, ca: NaN, cfx: NaN, cfy: NaN,
};
let lastAvatarVisible = null;

function setVarIfChanged(style, name, value, key) {
    if (lastCameraVar[key] !== value) {
        lastCameraVar[key] = value;
        style.setProperty(name, value);
    }
}

// Session-scoped intro camera drop — a purely visual offset applied to
// the local viewer's eye height. Other sessions never see it because
// we never touch the authoritative actor pose.
let cameraDropStartTime = 0;
let cameraDropEndTime = 0;
let cameraDropOffset = 0;

/**
 * Start a session-local visual drop of the camera. The offset decays
 * from `heightOffset` to 0 over `durationMs`, ease-out cubic. Because
 * this is written into `--view-z` on the local viewport only, nobody
 * else observes the drop.
 */
export function beginLocalCameraDrop(heightOffset = 80, durationMs = 1200) {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    cameraDropStartTime = now;
    cameraDropEndTime = now + durationMs;
    cameraDropOffset = heightOffset;
}

function currentCameraDropOffset(now) {
    if (cameraDropOffset === 0) return 0;
    if (now >= cameraDropEndTime) {
        cameraDropOffset = 0;
        return 0;
    }
    const span = cameraDropEndTime - cameraDropStartTime;
    const t = span > 0 ? (now - cameraDropStartTime) / span : 1;
    const ease = 1 - Math.pow(1 - t, 3);
    return cameraDropOffset * (1 - ease);
}

export function updateCamera() {
    const viewportStyle = dom.viewport.style;
    const eye = getControlledEye();
    if (!eye) return;

    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const dropOffset = currentCameraDropOffset(now);

    setVarIfChanged(viewportStyle, '--view-x', eye.x, 'vx');
    setVarIfChanged(viewportStyle, '--view-y', eye.y, 'vy');
    setVarIfChanged(viewportStyle, '--view-z', eye.z + dropOffset, 'vz');
    setVarIfChanged(viewportStyle, '--view-floor', eye.floorHeight || 0, 'vf');
    setVarIfChanged(viewportStyle, '--view-angle', eye.angle, 'va');

    // Precompute camera trig once per frame so CSS consumers (lighting,
    // frustum culling, spectator follow cam) can read scalar dot-product
    // inputs instead of re-evaluating sin/cos per element.
    const sa = Math.sin(eye.angle);
    const ca = Math.cos(eye.angle);
    setVarIfChanged(viewportStyle, '--sin-angle', sa, 'sa');
    setVarIfChanged(viewportStyle, '--cos-angle', ca, 'ca');
    setVarIfChanged(viewportStyle, '--camera-forward-x', -sa, 'cfx');
    setVarIfChanged(viewportStyle, '--camera-forward-y', ca, 'cfy');

    // The marine's world pose drives its third-person billboard (#avatar
    // DOM node) — exposed as --avatar-* on the viewport so the #avatar
    // transform picks them up. When no marine exists (e.g. headless
    // tests), skip both the pose write and the visibility toggle.
    const m = getMarineActor();
    const marinePose = m ? getRenderedPlayerPose() : null;
    if (marinePose) {
        setVarIfChanged(viewportStyle, '--avatar-x', marinePose.x, 'ax');
        setVarIfChanged(viewportStyle, '--avatar-y', marinePose.y, 'ay');
        setVarIfChanged(viewportStyle, '--avatar-floor', marinePose.floor || 0, 'af');
        setVarIfChanged(viewportStyle, '--avatar-angle', marinePose.angle, 'aa');
    }

    // Show the marine avatar whenever the local session isn't piloting
    // it and the marine is still alive — i.e. someone else is driving it
    // or we're spectating / possessing a monster. Visibility is a per-
    // actor concern, so we write directly on the #avatar DOM node rather
    // than via a body class.
    const marineController = m?.controller?.sessionId;
    const showAvatar = Boolean(m)
        && marineController !== LOCAL_SESSION
        && getControlled() !== m
        && m.deathMode !== 'gameover';
    if (showAvatar !== lastAvatarVisible) {
        lastAvatarVisible = showAvatar;
        const avatarEl = document.getElementById('avatar');
        if (avatarEl) avatarEl.classList.toggle('visible', showAvatar);
    }

    const marker = document.querySelector('#avatar > .marker');
    if (marker) {
        marker.classList.toggle('firing', Boolean(m?.isFiring));
    }

    if (showAvatar) {
        updateAvatarSpriteHeading(eye);
    }
}

/**
 * Pick the DOOM rotation row (0..4 + mirror) for the marine avatar sprite
 * based on where the viewer's eye sits relative to the marine's facing.
 */
let lastAvatarHeading = -1;
let lastAvatarMirror = -1;

function updateAvatarSpriteHeading(eye) {
    const sprite = document.querySelector('#avatar > .sprite');
    if (!sprite) return;

    const marine = getRenderedPlayerPose();
    const angleToViewer = Math.atan2(eye.y - marine.y, eye.x - marine.x);
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

    if (sheetRow !== lastAvatarHeading || mirrorScale !== lastAvatarMirror) {
        lastAvatarHeading = sheetRow;
        lastAvatarMirror = mirrorScale;
        sprite.style.setProperty('--heading', sheetRow);
        sprite.style.setProperty('--mirror', mirrorScale);
    }
}
