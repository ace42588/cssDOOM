/**
 * Body-swap picker — overlay UI for choosing which actor to possess.
 *
 * One actor at a time is under user control. This overlay pauses the
 * normal game input path (see `input/keyboard.js`) and shows a card for
 * every living body: the normal player character plus each surviving
 * monster. Clicking a card hands control to that body.
 */

import { listAvailableBodies, onPossessionChange } from '../../engine/possession.js';
import { requestBodySwap } from '../net/client.js';
import { formatRuntimeId } from '../../engine/actors/ids.js';

const overlay = document.createElement('div');
overlay.id = 'body-swap-overlay';
overlay.hidden = true;

const inner = document.createElement('div');
inner.id = 'body-swap-inner';

const title = document.createElement('h2');
title.className = 'body-swap-title';
title.textContent = 'Body Swap';
inner.appendChild(title);

const subtitle = document.createElement('div');
subtitle.className = 'body-swap-subtitle';
subtitle.textContent = 'Choose a body to inhabit. Press B or Esc to close.';
inner.appendChild(subtitle);

const list = document.createElement('div');
list.className = 'body-swap-list';
inner.appendChild(list);

overlay.appendChild(inner);
document.body.appendChild(overlay);

injectStyles();

let open = false;

export function isBodySwapOpen() {
    return open;
}

export function toggleBodySwap(show) {
    const nextOpen = show === undefined ? !open : Boolean(show);
    if (nextOpen === open) return;
    open = nextOpen;
    overlay.hidden = !open;
    if (open) renderBodies();
}

function renderBodies() {
    list.replaceChildren();
    const bodies = listAvailableBodies();
    if (bodies.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'body-swap-empty';
        empty.textContent = 'No living bodies available.';
        list.appendChild(empty);
        return;
    }

    for (const body of bodies) {
        const card = document.createElement('button');
        card.className = 'body-swap-card';
        if (body.isControlled) card.classList.add('active');
        card.dataset.kind = body.kind;
        if (body.type !== null && body.type !== undefined) card.dataset.type = body.type;

        const label = document.createElement('div');
        label.className = 'body-swap-label';
        label.textContent = body.label;
        card.appendChild(label);

        if (body.kind === 'door') {
            const meta = document.createElement('div');
            meta.className = 'body-swap-hp';
            meta.textContent = body.keyRequired
                ? `Needs ${body.keyRequired} key`
                : 'Security camera';
            card.appendChild(meta);
        } else {
            const hp = document.createElement('div');
            hp.className = 'body-swap-hp';
            hp.textContent = body.maxHp && body.maxHp !== body.hp
                ? `${body.hp} / ${body.maxHp} HP`
                : `${body.hp} HP`;
            card.appendChild(hp);
        }

        const badge = document.createElement('div');
        badge.className = 'body-swap-badge';
        badge.textContent = body.isControlled
            ? 'Controlling'
            : (body.kind === 'door' ? 'Operate' : 'Possess');
        card.appendChild(badge);

        card.addEventListener('click', () => {
            const targetId = targetIdForBody(body);
            if (!targetId) return;
            requestBodySwap(targetId);
            toggleBodySwap(false);
        });

        list.appendChild(card);
    }
}

function targetIdForBody(body) {
    if (body.kind === 'door') return `door:${body.sectorIndex}`;
    // `formatRuntimeId` returns `actor:<slot>` for every actor (marine or
    // enemy) and `thing:<index>` only for real `state.things` entries.
    // Enemies carry a synthetic `thingIndex` in the DOM-key range
    // (ACTOR_DOM_KEY_OFFSET+slot), so calling `getThingIndex` on them here
    // would mint a `thing:<bignum>` that the server can't resolve.
    return formatRuntimeId(body.entity);
}

// Re-render if the underlying set changes while the overlay is open
// (e.g. a monster dies while the user is scanning the list).
onPossessionChange(() => {
    if (open) renderBodies();
});

overlay.addEventListener('click', (e) => {
    if (e.target === overlay) toggleBodySwap(false);
});

function injectStyles() {
    if (document.getElementById('body-swap-styles')) return;
    const style = document.createElement('style');
    style.id = 'body-swap-styles';
    style.textContent = `
#body-swap-overlay {
    position: fixed;
    inset: 0;
    z-index: 1200;
    background: rgba(0, 0, 0, 0.82);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
    overflow-y: auto;
    font-family: 'PressStart2P', monospace;
    color: #ddd;
}
#body-swap-overlay[hidden] { display: none; }

#body-swap-inner {
    width: min(720px, 100%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
}
.body-swap-title {
    font-size: 20px;
    color: #ff5d3b;
    letter-spacing: 3px;
    text-transform: uppercase;
    margin: 0;
}
.body-swap-subtitle {
    font-size: 10px;
    color: #888;
    margin-bottom: 8px;
    text-align: center;
}
.body-swap-list {
    width: 100%;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 10px;
}
.body-swap-empty {
    grid-column: 1 / -1;
    text-align: center;
    color: #666;
    font-size: 10px;
    padding: 40px 0;
}
.body-swap-card {
    background: #111;
    border: 2px solid #333;
    color: #ddd;
    padding: 16px;
    cursor: pointer;
    font-family: inherit;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    transition: background 0.1s, border-color 0.1s, transform 0.1s;
    text-align: left;
}
.body-swap-card:hover {
    background: #1c1c1c;
    border-color: #ff5d3b;
    transform: translateY(-2px);
}
.body-swap-card.active {
    border-color: #ff5d3b;
    background: rgba(255, 93, 59, 0.12);
}
.body-swap-label {
    font-size: 12px;
    color: #fff;
}
.body-swap-hp {
    font-size: 10px;
    color: #bbb;
}
.body-swap-badge {
    font-size: 9px;
    margin-top: auto;
    padding: 4px 8px;
    background: #222;
    color: #ff5d3b;
    border-radius: 2px;
    align-self: flex-end;
}
.body-swap-card.active .body-swap-badge {
    background: #ff5d3b;
    color: #111;
}
`;
    document.head.appendChild(style);
}
