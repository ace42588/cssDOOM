/**
 * Per-frame HUD updates via CSS custom properties on #status.
 *
 * All HUD values (health, armor, ammo, face row, per-type ammo counts and
 * maximums) are set as custom properties on the #status container. CSS then
 * inherits these down to the digit elements, which use calc() to derive
 * individual digit sprite offsets. This keeps all per-element rendering in
 * CSS — JavaScript only touches one DOM element per frame.
 */

import { subscribeAmmo, AMMO_TYPES } from '../game/state.js';
import { getPlayerActor } from '../game/possession.js';
import { canSwitchWeapons } from '../game/entity/caps.js';
import { dom } from './dom.js';
import { WEAPONS } from '../game/constants.js';

// Previous values — only touch the DOM when something changes
let prev = {
    ammo: -1, health: -1, armor: -1, faceRow: -1,
};

// Per-type ammo dirty queue. Seeded with every type so the first frame
// flushes a complete set of CSS variables for the inventory panel.
// `subscribeAmmo` adds entries on every mutation thereafter, replacing
// the per-frame walk that used to read the marine's ammo/maxAmmo for
// every type whether or not anything changed. When the controlled body
// has no `ammo` proxy (e.g. a possessed monster) the subscription is
// dormant — nothing dirties, nothing writes.
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
    const controlled = getPlayerActor();
    // `possessed` renderer class hides the weapon / ammo rows via CSS
    // whenever the controlled actor can't switch weapons — covers
    // monster possession, spectator, and the pre-assignment window.
    const hasWeaponSwitching = canSwitchWeapons(controlled);
    const hasAmmo = Boolean(controlled?.ammo);
    const hasArmor = typeof controlled?.armor === 'number';
    dom.renderer.classList.toggle('possessed', !hasWeaponSwitching);

    const weaponSlot = controlled?.currentWeapon;
    const weapon = typeof weaponSlot === 'number' ? WEAPONS[weaponSlot] : null;
    const currentAmmo = hasAmmo && weapon?.ammoType
        ? Math.round(controlled.ammo[weapon.ammoType] ?? 0)
        : 0;
    const currentHealth = Math.round(controlled?.hp ?? 0);
    const currentArmor = hasArmor ? Math.round(controlled.armor) : 0;

    if (currentAmmo !== prev.ammo) {
        prev.ammo = currentAmmo;
        style.setProperty('--ammo', currentAmmo);
    }

    if (currentHealth !== prev.health) {
        prev.health = currentHealth;
        style.setProperty('--health', currentHealth);

        // Face-row scales to the controlled actor's own maxHp so the
        // portrait still tracks "how hurt you are" whether you're the
        // marine (maxHp=100) or a possessed demon (maxHp=150).
        const pct = controlled?.maxHp
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

    if (hasAmmo && ammoDirty.size) {
        for (const type of ammoDirty) {
            style.setProperty(`--ammo-${type}`, Math.round(controlled.ammo[type] ?? 0));
            style.setProperty(`--max-${type}`, controlled.maxAmmo?.[type] ?? 0);
        }
        ammoDirty.clear();
    }

    // Weapon ownership rows: only mark a slot owned when the controlled
    // actor actually has a weapon inventory that includes it.
    const owned = controlled?.ownedWeapons;
    for (let slot = 2; slot <= 7; slot++) {
        dom.renderer.classList.toggle(
            WEAPON_CLASSES[slot],
            Boolean(owned?.has?.(slot)),
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
