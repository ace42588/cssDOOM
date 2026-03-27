/**
 * Player entity — construction and visual state.
 */

import { dom } from '../../dom.js';

export function buildPlayer() {
    const player = document.createElement('div');
    player.id = 'player';
    const marker = document.createElement('div');
    marker.className = 'marker';
    player.appendChild(marker);
    const playerSprite = document.createElement('div');
    playerSprite.className = 'sprite';
    player.appendChild(playerSprite);
    dom.scene.appendChild(player);
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
