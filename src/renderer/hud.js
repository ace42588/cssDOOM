/**
 * Per-frame HUD updates via CSS custom properties on #status.
 *
 * All HUD values (health, armor, ammo, face row, per-type ammo counts and
 * maximums) are set as custom properties on the #status container. CSS then
 * inherits these down to the digit elements, which use calc() to derive
 * individual digit sprite offsets. This keeps all per-element rendering in
 * CSS — JavaScript only touches one DOM element per frame.
 */

import { getMarine, subscribeAmmo, AMMO_TYPES } from '../game/state.js';
import { getControlled, isControllingPlayer } from '../game/possession.js';
import { dom } from './dom.js';
import { WEAPONS } from '../game/constants.js';

// Previous values — only touch the DOM when something changes
let prev = {
    ammo: -1, health: -1, armor: -1, faceRow: -1,
};

// Per-type ammo dirty queue. Seeded with every type so the first frame
// flushes a complete set of CSS variables for the inventory panel.
// `subscribeAmmo` adds entries on every mutation thereafter, replacing the
// per-frame walk that used to read `getMarine().ammo` / `getMarine().maxAmmo` for
// every type whether or not anything changed.
const ammoDirty = new Set(AMMO_TYPES);
subscribeAmmo((type) => { ammoDirty.add(type); });

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
    const controlled = getControlled();
    const possessing = !isControllingPlayer();

    // Toggle possessed state on the renderer — CSS hides weapon/ammo rows.
    dom.renderer.classList.toggle('possessed', possessing);

    const weapon = WEAPONS[getMarine().currentWeapon];
    const currentAmmo = weapon.ammoType ? Math.round(getMarine().ammo[weapon.ammoType]) : 0;
    const currentHealth = possessing
        ? Math.round(controlled.hp ?? 0)
        : Math.round(getMarine().hp);
    // Armor lives only on the marine `player` object. Snapshots always carry
    // marine stats in `snap.player`, so when the camera/body is a monster
    // (possession or spectator follow) we must not show that inventory here.
    const currentArmor = possessing
        ? 0
        : Math.round(getMarine().armor);

    if (currentAmmo !== prev.ammo) {
        prev.ammo = currentAmmo;
        style.setProperty('--ammo', currentAmmo);
    }

    if (currentHealth !== prev.health) {
        prev.health = currentHealth;
        style.setProperty('--health', currentHealth);

        // Face row is driven by the possessed body's HP when possessing, so
        // the marine portrait still tracks how hurt "you" are.
        const pct = possessing && controlled.maxHp
            ? (currentHealth / controlled.maxHp) * 100
            : currentHealth;
        const faceRow = pct >= 80 ? 0 : pct >= 60 ? 1 : pct >= 40 ? 2 : pct >= 20 ? 3 : 4;
        if (faceRow !== prev.faceRow) {
            prev.faceRow = faceRow;
            style.setProperty('--face-row', faceRow);
        }
    }

    if (currentArmor !== prev.armor) {
        prev.armor = currentArmor;
        style.setProperty('--armor', currentArmor);
    }

    if (ammoDirty.size) {
        for (const type of ammoDirty) {
            style.setProperty(`--ammo-${type}`, Math.round(getMarine().ammo[type]));
            style.setProperty(`--max-${type}`, getMarine().maxAmmo[type]);
        }
        ammoDirty.clear();
    }

    // Weapon ownership — hide all slots while possessing (monsters don't
    // own player weapons).
    for (let weaponSlot = 2; weaponSlot <= 7; weaponSlot++) {
        dom.renderer.classList.toggle(
            WEAPON_CLASSES[weaponSlot],
            !possessing && getMarine().ownedWeapons.has(weaponSlot),
        );
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
