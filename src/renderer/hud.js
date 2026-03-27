/**
 * Per-frame HUD updates via CSS custom properties on #status.
 *
 * All HUD values (health, armor, ammo, face row, per-type ammo counts and
 * maximums) are set as custom properties on the #status container. CSS then
 * inherits these down to the digit elements, which use calc() to derive
 * individual digit sprite offsets. This keeps all per-element rendering in
 * CSS — JavaScript only touches one DOM element per frame.
 */

import { state } from '../game/state.js';
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

export function updateHud() {
    const style = dom.status.style;
    const weapon = WEAPONS[state.currentWeapon];
    const currentAmmo = weapon.ammoType ? Math.round(state.ammo[weapon.ammoType]) : 0;
    const currentHealth = Math.round(state.health);
    const currentArmor = Math.round(state.armor);

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
        const cur = Math.round(state.ammo[type]);
        if (cur !== prev[type]) {
            prev[type] = cur;
            style.setProperty(`--ammo-${type}`, cur);
        }

        const max = state.maxAmmo[type];
        const maxKey = `max${type[0].toUpperCase()}${type.slice(1)}`;
        if (max !== prev[maxKey]) {
            prev[maxKey] = max;
            style.setProperty(`--max-${type}`, max);
        }
    }

    // Weapon ownership
    for (let weaponSlot = 2; weaponSlot <= 7; weaponSlot++) {
        dom.renderer.classList.toggle(WEAPON_CLASSES[weaponSlot], state.ownedWeapons.has(weaponSlot));
    }
}

export function clearWeaponSlots() {
    dom.renderer.classList.remove(
        'has-weapon-2', 'has-weapon-3', 'has-weapon-4',
        'has-weapon-5', 'has-weapon-6', 'has-weapon-7'
    );
}
