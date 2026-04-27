/**
 * Join challenge overlay — new human chooses to displace an MCP agent or spectate.
 */

import * as rendererFacade from '../../engine/ports/renderer.js';
import { sendJoinChallengeDecision } from '../net/client.js';

const overlay = document.createElement('div');
overlay.id = 'join-challenge-overlay';
overlay.hidden = true;

const inner = document.createElement('div');
inner.id = 'join-challenge-inner';

const title = document.createElement('h2');
title.className = 'join-challenge-title';
title.textContent = 'Another player holds this body';

const subtitle = document.createElement('div');
subtitle.className = 'join-challenge-subtitle';

const defenseBlock = document.createElement('div');
defenseBlock.className = 'join-challenge-defense';

const actions = document.createElement('div');
actions.className = 'join-challenge-actions';

const btnDisplace = document.createElement('button');
btnDisplace.type = 'button';
btnDisplace.className = 'join-challenge-btn join-challenge-btn-primary';
btnDisplace.textContent = 'Displace agent';

const btnSpectate = document.createElement('button');
btnSpectate.type = 'button';
btnSpectate.className = 'join-challenge-btn';
btnSpectate.textContent = 'Stay spectator';

actions.append(btnDisplace, btnSpectate);
inner.append(title, subtitle, defenseBlock, actions);
overlay.appendChild(inner);
document.body.appendChild(overlay);

injectStyles();

let open = false;
/** @type {{ challengeId: string }|null} */
let pending = null;

export function isJoinChallengeOpen() {
    return open;
}

function hide() {
    open = false;
    overlay.hidden = true;
    pending = null;
}

function onDisplace() {
    if (!pending) return;
    sendJoinChallengeDecision(pending.challengeId, 'displace');
    hide();
}

function onSpectate() {
    if (!pending) return;
    sendJoinChallengeDecision(pending.challengeId, 'spectate');
    hide();
}

btnDisplace.addEventListener('click', onDisplace);
btnSpectate.addEventListener('click', onSpectate);

/** @param {object} data — parsed joinChallenge server message */
export function handleJoinChallenge(data) {
    if (data.autoResolved) {
        rendererFacade.showHudMessage('You took a body from an MCP agent (no defense / timeout).', 4500);
        hide();
        return;
    }

    pending = { challengeId: data.challengeId };
    open = true;
    overlay.hidden = false;

    const agent = data.targetAgent || {};
    subtitle.textContent = `${agent.agentName || 'MCP agent'} (${agent.agentId || 'unknown'}) defends this slot. Decide before the timer expires.`;

    if (data.defense && data.defense.justification) {
        const q = document.createElement('blockquote');
        q.className = 'join-challenge-quote';
        q.textContent = data.defense.justification;
        defenseBlock.replaceChildren(q);
        if (data.defense.intendedAction) {
            const intent = document.createElement('div');
            intent.className = 'join-challenge-intent';
            intent.textContent = `Next intent: ${data.defense.intendedAction}`;
            defenseBlock.appendChild(intent);
        }
    } else {
        defenseBlock.textContent = '';
    }
}

export function dismissJoinChallengeAsSpectate() {
    if (!open || !pending) {
        hide();
        return;
    }
    onSpectate();
}

function injectStyles() {
    if (document.getElementById('join-challenge-styles')) return;
    const style = document.createElement('style');
    style.id = 'join-challenge-styles';
    style.textContent = `
#join-challenge-overlay {
  position: fixed;
  inset: 0;
  z-index: 12000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0,0,0,0.75);
  font-family: system-ui, sans-serif;
  color: #eee;
}
#join-challenge-overlay[hidden] { display: none; }
#join-challenge-inner {
  max-width: 32rem;
  padding: 1.5rem;
  background: #1a1a22;
  border: 2px solid #c94;
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.6);
}
.join-challenge-title { margin: 0 0 0.5rem; font-size: 1.25rem; color: #fc8; }
.join-challenge-subtitle { font-size: 0.9rem; color: #aaa; margin-bottom: 1rem; }
.join-challenge-defense { margin: 1rem 0; line-height: 1.45; }
.join-challenge-quote { margin: 0; padding: 0.75rem 1rem; background: #111; border-left: 4px solid #c94; color: #ddd; }
.join-challenge-intent { margin-top: 0.5rem; font-size: 0.85rem; color: #9cf; }
.join-challenge-actions { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 1rem; }
.join-challenge-btn {
  padding: 0.5rem 1rem;
  font-size: 1rem;
  cursor: pointer;
  border-radius: 4px;
  border: 1px solid #666;
  background: #333;
  color: #eee;
}
.join-challenge-btn-primary {
  background: #7a2222;
  border-color: #c44;
  color: #fff;
}
.join-challenge-btn:hover { filter: brightness(1.1); }
`;
    document.head.appendChild(style);
}
