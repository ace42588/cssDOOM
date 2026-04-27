/**
 * Renders toggle checkboxes that add/remove CSS classes on <body>
 * to enable visual debug features (lighting, scrolling textures, etc.).
 * Also provides culling toggles with live stats.
 */

import { culling, cullingStats } from '../renderer/scene/culling.js';
import { debug } from '../game/state.js';

const TOGGLES = [
    { name: 'sector-lights', label: 'Sector light effects', defaultOn: true },
    { name: 'light-falloff', label: 'Light falloff', defaultOn: false },
    { name: 'scroll-textures', label: 'Scrolling textures', defaultOn: true },
    { name: 'animated-flats', label: 'Animated flats', defaultOn: true },
    { name: 'head-bob', label: 'Head bob', defaultOn: true },
];

// Apply default feature toggles immediately so they work without the debug menu
for (const toggle of TOGGLES) {
    if (toggle.defaultOn) document.body.classList.add(toggle.name);
}

const DEBUG_TOGGLES = [
    { name: 'all-enemies-shadow', label: 'All enemies shadow', defaultOn: false },
    { name: 'show-wall-ids', label: 'Show wall IDs', defaultOn: false },
    { name: 'show-sector-ids', label: 'Show sector IDs', defaultOn: false },
];

// Ordered to match processing order in updateCulling()
const CULLING_TOGGLES = [
    { key: 'pvs', label: 'Sector PVS', statKey: 'afterPvs' },
    { key: 'distance', label: 'Distance culling', statKey: 'afterDistance' },
    { key: 'backface', label: 'Backface culling', statKey: 'afterBackface' },
    { key: 'frustum', label: 'Frustum culling', statKey: 'afterFrustum' },
    { key: 'sky', label: 'Sky culling', statKey: 'afterSky' },
];

const cullingStatElements = {};

export function initDebugMenu() {
    const details = document.createElement('details');
    details.id = 'debug-menu';

    const summary = document.createElement('summary');
    summary.textContent = 'Debug';
    details.appendChild(summary);

    // Visual toggles
    for (const toggle of TOGGLES) {
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = document.body.classList.contains(toggle.name);

        checkbox.addEventListener('change', () => {
            document.body.classList.toggle(toggle.name, checkbox.checked);
        });

        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(` ${toggle.label}`));
        details.appendChild(label);
    }

    // Separator
    const hr = document.createElement('hr');
    hr.style.cssText = 'border:0;border-top:1px solid #444;margin:4px 0';
    details.appendChild(hr);

    // Culling toggles (in processing order) with per-step stats
    for (const toggle of CULLING_TOGGLES) {
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = culling[toggle.key];

        checkbox.addEventListener('change', () => {
            culling[toggle.key] = checkbox.checked;
        });

        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(` ${toggle.label}`));
        details.appendChild(label);

        const stat = document.createElement('div');
        stat.style.cssText = 'font-size:11px;color:#888;padding-left:20px';
        details.appendChild(stat);
        cullingStatElements[toggle.statKey] = stat;
    }

    // Separator
    const hr2 = document.createElement('hr');
    hr2.style.cssText = 'border:0;border-top:1px solid #444;margin:4px 0';
    details.appendChild(hr2);

    // Gameplay toggles
    const noAttackLabel = document.createElement('label');
    const noAttackCheckbox = document.createElement('input');
    noAttackCheckbox.type = 'checkbox';
    noAttackCheckbox.checked = false;
    noAttackCheckbox.addEventListener('change', () => {
        debug.noEnemyAttack = noAttackCheckbox.checked;
    });
    noAttackLabel.appendChild(noAttackCheckbox);
    noAttackLabel.appendChild(document.createTextNode(' No enemy attack'));
    details.appendChild(noAttackLabel);

    const noMoveLabel = document.createElement('label');
    const noMoveCheckbox = document.createElement('input');
    noMoveCheckbox.type = 'checkbox';
    noMoveCheckbox.checked = false;
    noMoveCheckbox.addEventListener('change', () => {
        debug.noEnemyMove = noMoveCheckbox.checked;
    });
    noMoveLabel.appendChild(noMoveCheckbox);
    noMoveLabel.appendChild(document.createTextNode(' No enemy movement'));
    details.appendChild(noMoveLabel);

    const noclipLabel = document.createElement('label');
    const noclipCheckbox = document.createElement('input');
    noclipCheckbox.type = 'checkbox';
    noclipCheckbox.checked = false;
    noclipCheckbox.addEventListener('change', () => {
        debug.noclip = noclipCheckbox.checked;
    });
    noclipLabel.appendChild(noclipCheckbox);
    noclipLabel.appendChild(document.createTextNode(' No collision (noclip)'));
    details.appendChild(noclipLabel);

    // Separator
    const hr3 = document.createElement('hr');
    hr3.style.cssText = 'border:0;border-top:1px solid #444;margin:4px 0';
    details.appendChild(hr3);

    // Debug visualization toggles
    for (const toggle of DEBUG_TOGGLES) {
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = toggle.defaultOn;

        if (toggle.defaultOn) document.body.classList.add(toggle.name);

        checkbox.addEventListener('change', () => {
            document.body.classList.toggle(toggle.name, checkbox.checked);
        });

        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(` ${toggle.label}`));
        details.appendChild(label);
    }

    document.body.appendChild(details);
}

/** Update the stats text. Called each frame from the game loop. */
export function updateDebugStats() {
    const { total, visibleSectors, totalSectors } = cullingStats;
    const anyCulling = culling.pvs || culling.frustum || culling.distance || culling.backface;

    // Per-step stats: show "input → output" for each enabled step
    let prev = total;
    for (const toggle of CULLING_TOGGLES) {
        const el = cullingStatElements[toggle.statKey];
        if (!el) continue;
        if (anyCulling && culling[toggle.key]) {
            const after = cullingStats[toggle.statKey];
            if (toggle.key === 'pvs') {
                el.textContent = `${prev} → ${after}  (${visibleSectors}/${totalSectors} sectors)`;
            } else {
                el.textContent = `${prev} → ${after}`;
            }
            prev = after;
        } else {
            el.textContent = '';
        }
    }
}
