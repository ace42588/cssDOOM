/**
 * MCP-facing role guidance for whatever body a session controls (or will
 * control after the next tick applies a queued bodySwap).
 */

import { player } from '../../src/game/state.js';
import { WEAPONS } from '../../src/game/constants.js';
import { getThingIndex } from '../../src/game/things/registry.js';
import { enemyLabel } from './snapshot.js';

const ENEMY_GUIDANCE = {
    3004: 'Weak hitscan grunt. Keep some distance; `actor-fire` uses your pistol-style attack. You cannot switch weapons or pick up keys.',
    9: 'Tougher hitscan enemy with a shotgun-like attack at medium range. Close carefully. `actor-fire` uses your native attack.',
    3001: 'Ranged attacker: `actor-fire` throws fireballs. Keep distance; strafe between shots. No weapon switching or key pickup as an imp.',
    3002: 'Melee bruiser: `actor-fire` is a bite at short range. Close the gap; walls block you like any body. No keys on this body.',
    58: 'Same as Demon but partially invisible — same melee bite via `actor-fire`.',
    3003: 'Heavy hitter with long-range plasma via `actor-fire`. Tank damage and pressure targets; still no marine weapons or keys.',
};

function weaponLine() {
    const w = WEAPONS[player.currentWeapon] || WEAPONS[2];
    const name = w?.name || `slot ${player.currentWeapon}`;
    return `Equipped weapon slot: ${player.currentWeapon} (${name}). Use \`actor-switch-weapon\` for slots you own; \`actor-fire\` fires it.`;
}

function keysLine() {
    const keys = player.collectedKeys?.length ? player.collectedKeys.join(', ') : 'none yet';
    return `Keys carried (marine inventory): ${keys}. Key-locked doors check this inventory even while you possess something else.`;
}

/**
 * @param {import('../../src/game/state.js').Player|import('../../src/game/state.js').Thing|null} entity
 * @returns {{ kind: string, label: string, id: string|null, text: string }}
 */
export function rolePromptFor(entity) {
    if (!entity) {
        return {
            kind: 'spectator',
            label: 'Spectator',
            id: null,
            text: 'No playable body right now. Poll `world-get-state` and `world-poll-events`; when a body frees up you may be reassigned on reconnect or map change.',
        };
    }
    if (entity === player) {
        return {
            kind: 'marine',
            label: 'Marine',
            id: 'player',
            text: [
                'You are the marine: explore, fight, open doors, and finish the map.',
                weaponLine(),
                keysLine(),
                'Use `actor-set-move` / `actor-turn-by` to move and aim; `actor-use` opens doors and switches in front of you; `actor-stop` clears stuck movement intent.',
            ].join(' '),
        };
    }
    if (entity.__isDoorEntity) {
        const n = entity.sectorIndex;
        return {
            kind: 'door',
            label: 'Door operator',
            id: `door:${n}`,
            text: 'You operate this door\'s security camera. `actor-set-move` / `actor-turn-by` rotate your view. `doors-approve-request` and `doors-deny-request` only take effect while you are still the current operator — another session can steal the camera. `actor-fire` and `actor-use` do nothing useful here.',
        };
    }
    const label = enemyLabel(entity.type);
    const idx = getThingIndex(entity);
    const id = idx >= 0 ? `thing:${idx}` : null;
    const specific = ENEMY_GUIDANCE[entity.type] || 'Hostile monster body. `actor-fire` triggers your native attack; `actor-switch-weapon` is ignored.';
    return {
        kind: 'enemy',
        label,
        id,
        text: `You are a ${label}. ${specific} Use \`actor-set-move\` / \`actor-turn-by\` to navigate; marine keys still gate key-locked doors from your use press.`,
    };
}
