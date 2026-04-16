/**
 * Per-frame HUD updates via CSS custom properties on #status.
 *
 * All HUD values (health, armor, ammo, face row, per-type ammo counts and
 * maximums) are set as custom properties on the #status container. CSS then
 * inherits these down to the digit elements, which use calc() to derive
 * individual digit sprite offsets. This keeps all per-element rendering in
 * CSS — JavaScript only touches one DOM element per frame.
 */

import { player } from '../game/state.js';
import { dom } from './dom.js';
import { WEAPONS } from '../game/constants.js';

const AMMO_TYPES = ['bullets', 'shells', 'rockets', 'cells'];

// Previous values — only touch the DOM when something changes
let prev = {
    ammo: -1, health: -1, armor: -1, faceRow: -1,
    bullets: -1, shells: -1, rockets: -1, cells: -1,
    maxBullets: -1, maxShells: -1, maxRockets: -1, maxCells: -1,
};

// Pre-built class name strings to avoid per-frame template literal allocation
const WEAPON_CLASSES = { 2: 'has-weapon-2', 3: 'has-weapon-3', 4: 'has-weapon-4', 5: 'has-weapon-5', 6: 'has-weapon-6', 7: 'has-weapon-7' };
let hudMessageElement = null;
let hudMessageTimer = null;

function ensureHudMessageElement() {
    if (hudMessageElement) return hudMessageElement;
    hudMessageElement = document.createElement('div');
    hudMessageElement.id = 'hud-message';
    dom.renderer.appendChild(hudMessageElement);
    return hudMessageElement;
}

export function updateHud() {
    const style = dom.status.style;
    const weapon = WEAPONS[player.currentWeapon];
    const currentAmmo = weapon.ammoType ? Math.round(player.ammo[weapon.ammoType]) : 0;
    const currentHealth = Math.round(player.health);
    const currentArmor = Math.round(player.armor);

    if (currentAmmo !== prev.ammo) {
        prev.ammo = currentAmmo;
        style.setProperty('--ammo', currentAmmo);
    }

    if (currentHealth !== prev.health) {
        prev.health = currentHealth;
        style.setProperty('--health', currentHealth);

        const faceRow = currentHealth >= 80 ? 0 : currentHealth >= 60 ? 1 : currentHealth >= 40 ? 2 : currentHealth >= 20 ? 3 : 4;
        if (faceRow !== prev.faceRow) {
            prev.faceRow = faceRow;
            style.setProperty('--face-row', faceRow);
        }
    }

    if (currentArmor !== prev.armor) {
        prev.armor = currentArmor;
        style.setProperty('--armor', currentArmor);
    }

    // Per-type ammo counts and maximums
    for (const type of AMMO_TYPES) {
        const cur = Math.round(player.ammo[type]);
        if (cur !== prev[type]) {
            prev[type] = cur;
            style.setProperty(`--ammo-${type}`, cur);
        }

        const max = player.maxAmmo[type];
        const maxKey = `max${type[0].toUpperCase()}${type.slice(1)}`;
        if (max !== prev[maxKey]) {
            prev[maxKey] = max;
            style.setProperty(`--max-${type}`, max);
        }
    }

    // Weapon ownership
    for (let weaponSlot = 2; weaponSlot <= 7; weaponSlot++) {
        dom.renderer.classList.toggle(WEAPON_CLASSES[weaponSlot], player.ownedWeapons.has(weaponSlot));
    }
}

export function clearWeaponSlots() {
    dom.renderer.classList.remove(
        'has-weapon-2', 'has-weapon-3', 'has-weapon-4',
        'has-weapon-5', 'has-weapon-6', 'has-weapon-7'
    );
}

/**
 * Show a transient message near the HUD (e.g. access denials).
 */
export function showHudMessage(message, durationMs = 1500) {
    const text = `${message || ''}`.trim();
    if (!text) return;

    const el = ensureHudMessageElement();
    el.textContent = text;
    el.classList.add('visible');

    clearTimeout(hudMessageTimer);
    hudMessageTimer = setTimeout(() => {
        el.classList.remove('visible');
    }, durationMs);
}
