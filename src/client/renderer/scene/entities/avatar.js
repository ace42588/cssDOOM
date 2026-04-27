/**
 * Avatar entity — the world-billboard sprite used to render the marine
 * actor when it isn't the locally-controlled body (someone else drives
 * it, the local viewer possesses a monster, or we're spectating).
 *
 * The node lives under `#scene` and reads `--avatar-*` CSS vars written
 * by `camera.js` so it follows the marine actor's real world pose. The
 * camera eye / HUD / audio listener stay on the locally-controlled
 * actor — this billboard is the other sessions' view of the marine
 * from the outside.
 *
 * Death / moving / key pickup flags live on the renderer root
 * (`#renderer`) because they drive first-person HUD overlays, not the
 * avatar's billboard.
 */

import { dom } from '../../dom.js';

export function buildAvatar() {
    const avatar = document.createElement('div');
    avatar.id = 'avatar';
    const marker = document.createElement('div');
    marker.className = 'marker';
    avatar.appendChild(marker);
    const avatarSprite = document.createElement('div');
    avatarSprite.className = 'sprite';
    avatar.appendChild(avatarSprite);
    dom.scene.appendChild(avatar);
}

export function setPlayerDead(dead) {
    dom.renderer.classList.toggle('dead', dead);
}

export function setPlayerMoving(moving) {
    dom.renderer.classList.toggle('moving', moving);
}

export function collectKey(color) {
    dom.renderer.classList.add(`has-${color}-key`);
}

export function clearKeys() {
    dom.renderer.classList.remove('has-blue-key', 'has-yellow-key', 'has-red-key');
}
