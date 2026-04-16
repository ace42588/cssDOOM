/**
 * Menu — level picker and skill selection overlay.
 */

import { state } from '../game/state.js';
import { currentMap } from '../data/maps.js';
import { dom } from '../renderer/dom.js';
import { MAPS } from '../data/maps.js';
import { loadMap } from '../game/lifecycle.js';

const menuLevelList = document.querySelector('.menu-level-list');

// Build level buttons with HUD digit sprites
for (const name of MAPS) {
    const btn = document.createElement('button');
    btn.className = 'menu-level';
    btn.dataset.map = name;

    // Level number is the last character (e.g. "1" from "E1M1")
    const levelNum = parseInt(name.slice(-1));
    const digit = document.createElement('span');
    digit.className = 'level-digit';
    digit.style.setProperty('--level', levelNum);
    btn.appendChild(digit);

    btn.addEventListener('click', () => {
        loadMap(name);
        updateMenuSelection();
        toggleMenu(false);
    });

    menuLevelList.appendChild(btn);
}

// Skill buttons
document.querySelectorAll('.menu-skill').forEach(btn => {
    btn.addEventListener('click', () => {
        state.skillLevel = parseInt(btn.dataset.skill);
        loadMap(currentMap);
        updateMenuSelection();
        toggleMenu(false);
    });
});

export function updateMenuSelection() {
    document.querySelectorAll('.menu-level').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.map === currentMap);
    });
    document.querySelectorAll('.menu-skill').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.skill) === state.skillLevel);
    });
}

// ============================================================================
// Menu state & toggle
// ============================================================================

let menuOpen = false;

/** Returns true if the menu overlay is currently open. */
export function isMenuOpen() {
    return menuOpen;
}

export function toggleMenu(show) {
    if (show === menuOpen) return;
    menuOpen = show;

    if (show) {
        dom.menuOverlay.hidden = false;
        dom.menuOverlay.classList.add('showing');

        // Force layout so the browser captures the "before" state
        dom.menuOverlay.offsetHeight;
        dom.menuOverlay.classList.remove('showing');
        updateMenuSelection();
    } else {
        dom.menuOverlay.classList.add('hiding');
        dom.menuOverlay.addEventListener('transitionend', function onEnd() {
            dom.menuOverlay.removeEventListener('transitionend', onEnd);
            dom.menuOverlay.hidden = true;
            dom.menuOverlay.classList.remove('hiding');
        });
    }
}

dom.menuButton.addEventListener('click', () => {
    toggleMenu(!menuOpen);
});

dom.menuOverlay.addEventListener('click', (e) => {
    if (e.target === dom.menuOverlay) toggleMenu(false);
});
