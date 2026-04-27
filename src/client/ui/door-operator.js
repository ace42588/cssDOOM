/**
 * Door operator modal — shown when the local session possesses a door and
 * another entity tries to use it. The operator either approves the open
 * or ignores the request.
 *
 * Runs as a passive observer: each animation frame we look at the body
 * bound to the local session (`getControlled()`). If it is a door entity
 * with a non-empty `pendingRequests` queue, we render / update the modal.
 *
 * Decisions travel back through the net client as a `doorDecision` input
 * flag so the authoritative server can apply them.
 */

import { getControlled } from '../../engine/possession.js';
import { requestDoorDecision } from '../net/client.js';

const overlay = document.createElement('div');
overlay.id = 'door-operator-overlay';
overlay.hidden = true;

const inner = document.createElement('div');
inner.id = 'door-operator-inner';
overlay.appendChild(inner);

const title = document.createElement('h2');
title.className = 'door-operator-title';
title.textContent = 'Door Access Request';
inner.appendChild(title);

const subtitle = document.createElement('div');
subtitle.className = 'door-operator-subtitle';
inner.appendChild(subtitle);

const detailsEl = document.createElement('dl');
detailsEl.className = 'door-operator-details';
inner.appendChild(detailsEl);

const actions = document.createElement('div');
actions.className = 'door-operator-actions';
inner.appendChild(actions);

const openBtn = document.createElement('button');
openBtn.type = 'button';
openBtn.className = 'door-operator-btn door-operator-btn-open';
openBtn.textContent = 'Open Door';
actions.appendChild(openBtn);

const ignoreBtn = document.createElement('button');
ignoreBtn.type = 'button';
ignoreBtn.className = 'door-operator-btn door-operator-btn-ignore';
ignoreBtn.textContent = 'Ignore';
actions.appendChild(ignoreBtn);

document.body.appendChild(overlay);
injectStyles();

let currentKey = null;
let currentSectorIndex = null;
let currentRequestId = null;
// Keys the operator already resolved locally; prevents a flicker between
// pressing Open/Ignore and the server snapshot that drains the request.
const decidedKeys = new Set();

openBtn.addEventListener('click', () => sendDecision('open'));
ignoreBtn.addEventListener('click', () => sendDecision('ignore'));

function sendDecision(decision) {
    if (currentSectorIndex == null || currentRequestId == null) return;
    decidedKeys.add(`${currentSectorIndex}#${currentRequestId}`);
    requestDoorDecision(currentSectorIndex, currentRequestId, decision);
    hide();
}

export function isDoorOperatorOpen() {
    return !overlay.hidden;
}

/**
 * Polled every frame from `index.js`. Cheap when the local session isn't
 * controlling a door — `getControlled()` is a Map read.
 */
export function updateDoorOperator() {
    const controlled = getControlled();
    if (!controlled || !controlled.__isDoorEntity) {
        if (!overlay.hidden) hide();
        return;
    }
    const queue = controlled.pendingRequests || [];
    if (queue.length === 0) {
        if (!overlay.hidden) hide();
        return;
    }

    // Skip over any requests the operator already decided locally but
    // whose server-side drain hasn't round-tripped yet.
    const req = queue.find((r) => !decidedKeys.has(`${controlled.sectorIndex}#${r.id}`));
    if (!req) {
        if (!overlay.hidden) hide();
        return;
    }
    // Prune decidedKeys entries that are no longer in the queue — those
    // have been drained by the server and can be forgotten.
    for (const k of decidedKeys) {
        const [sectorStr, idStr] = k.split('#');
        const sectorIndex = Number(sectorStr);
        const reqId = Number(idStr);
        if (sectorIndex !== controlled.sectorIndex) continue;
        if (!queue.some((r) => r.id === reqId)) decidedKeys.delete(k);
    }

    const key = `${controlled.sectorIndex}#${req.id}`;
    if (key === currentKey) return;
    currentKey = key;
    currentSectorIndex = controlled.sectorIndex;
    currentRequestId = req.id;
    renderRequest(controlled, req);
    overlay.hidden = false;
}

function hide() {
    overlay.hidden = true;
    currentKey = null;
    currentSectorIndex = null;
    currentRequestId = null;
}

function renderRequest(doorEntity, req) {
    subtitle.textContent = `Door #${doorEntity.sectorIndex} — someone is at the door.`;
    detailsEl.replaceChildren();
    addRow('Who', req.interactorLabel || 'Unknown');
    if (req.approachSide) addRow('From', req.approachSide);
    const details = req.interactorDetails || {};
    if (details.kind) addRow('Kind', details.kind);
    if (details.type != null) addRow('Type', String(details.type));
    if (details.hp != null) {
        const hpStr = details.maxHp ? `${details.hp} / ${details.maxHp}` : String(details.hp);
        addRow('HP', hpStr);
    }
    if (details.armor != null) addRow('Armor', String(details.armor));
    if (Array.isArray(details.keys) && details.keys.length) {
        addRow('Keys', details.keys.join(', '));
    }
    if (details.sessionId) addRow('Session', details.sessionId);
}

function addRow(term, value) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    detailsEl.append(dt, dd);
}

function injectStyles() {
    if (document.getElementById('door-operator-styles')) return;
    const style = document.createElement('style');
    style.id = 'door-operator-styles';
    style.textContent = `
#door-operator-overlay {
    position: fixed;
    inset: 0;
    z-index: 1300;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
    font-family: 'PressStart2P', monospace;
    color: #ddd;
}
#door-operator-overlay[hidden] { display: none; }
#door-operator-inner {
    width: min(480px, 100%);
    background: #111;
    border: 2px solid #ff5d3b;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    box-shadow: 0 0 24px rgba(255, 93, 59, 0.2);
}
.door-operator-title {
    font-size: 16px;
    color: #ff5d3b;
    margin: 0;
    letter-spacing: 2px;
    text-transform: uppercase;
}
.door-operator-subtitle {
    font-size: 10px;
    color: #aaa;
}
.door-operator-details {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 12px;
    row-gap: 4px;
    margin: 0;
    font-size: 10px;
}
.door-operator-details dt {
    color: #888;
    text-transform: uppercase;
    letter-spacing: 1px;
}
.door-operator-details dd {
    margin: 0;
    color: #eee;
    word-break: break-word;
}
.door-operator-actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    margin-top: 4px;
}
.door-operator-btn {
    font-family: inherit;
    font-size: 10px;
    padding: 10px 14px;
    border: 2px solid #333;
    background: #181818;
    color: #ddd;
    cursor: pointer;
    letter-spacing: 1px;
    text-transform: uppercase;
}
.door-operator-btn-open {
    border-color: #ff5d3b;
    color: #ff5d3b;
}
.door-operator-btn-open:hover {
    background: #ff5d3b;
    color: #111;
}
.door-operator-btn-ignore:hover {
    background: #222;
}
`;
    document.head.appendChild(style);
}
