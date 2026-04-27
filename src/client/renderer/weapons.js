/**
 * Weapon element rendering — switching animation, fire animation, sprite swaps.
 */

import { dom } from './dom.js';

/** Returns true if the weapon element is currently in the switching animation. */
export function isWeaponSwitching() {
    return dom.weaponElement.classList.contains('switching');
}

/**
 * Switch to a new weapon. If the weapon is different from the current one and
 * no switch is already in progress, plays a lower-then-raise animation and
 * swaps the sprite at the midpoint. Otherwise applies immediately.
 */
export function switchWeapon(weaponName, fireRate) {
    const currentType = dom.weaponElement.dataset.type;
    const needsAnimation = weaponName !== currentType && !isWeaponSwitching();

    if (needsAnimation) {
        dom.weaponElement.classList.remove('firing');
        dom.weaponElement.classList.add('switching');

        setTimeout(() => applyWeaponVisuals(weaponName, fireRate), 200);

        dom.weaponElement.addEventListener('animationend', function onEnd(event) {
            if (event.animationName === 'weapon-switch') {
                dom.weaponElement.classList.remove('switching');
                dom.weaponElement.removeEventListener('animationend', onEnd);
            }
        });
    } else {
        applyWeaponVisuals(weaponName, fireRate);
    }
}

/** Apply the weapon visuals and fire-rate timing. */
function applyWeaponVisuals(weaponName, fireRate) {
    dom.weaponElement.classList.remove('firing');
    dom.weaponElement.dataset.type = weaponName;
    dom.weaponElement.style.setProperty('--fire-duration', `${fireRate}ms`);
}

/** Start the weapon fire CSS animation (restart via forced reflow). */
export function startFiring() {
    dom.weaponElement.classList.remove('firing');
    void dom.weaponElement.offsetWidth;
    dom.weaponElement.classList.add('firing');
}

/** Remove the firing class from the weapon element. */
export function stopFiring() {
    dom.weaponElement.classList.remove('firing');
}

// Clean up the firing class when the CSS fire animation completes,
// so the weapon returns to its idle sprite frame.
document.addEventListener('animationend', event => {
    if (event.animationName === 'weapon-fire') {
        dom.weaponElement.classList.remove('firing');
    }
});
