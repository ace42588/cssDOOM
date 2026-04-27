/**
 * MCP-facing role guidance for whatever body a session controls (or will
 * control after the next tick applies a queued bodySwap).
 *
 * Prompts are assembled from the actor's capability blocks:
 *   - `ownedWeapons` / `ammo` → weapon guidance (`actor-switch-weapon`).
 *   - `collectedKeys` → key inventory line.
 *   - `ai` / `brain` → monster-body attack repertoire.
 *   - `__isDoorEntity` → door-camera guidance.
 */

import { WEAPONS, ENEMY_PROJECTILES } from '../../src/engine/constants.js';
import { enemyLabel, kindOfActor, actorIdOf } from '../../src/engine/snapshot.js';

/**
 * Describe a monster body's attack repertoire purely from its capability
 * data (`entity.ai` + `ENEMY_PROJECTILES[type]`) instead of a per-type
 * lookup table. New monsters with the same capability shape inherit
 * sensible guidance without a role-table edit.
 */
function describeMonsterAttacks(entity) {
    const ai = entity?.ai;
    const hasProjectile = ENEMY_PROJECTILES[entity?.type] != null;
    if (!ai) return '`actor-fire` triggers your native attack; `actor-switch-weapon` is ignored.';
    if (ai.melee && !hasProjectile) {
        const range = Math.round(ai.meleeRange ?? ai.attackRange ?? 64);
        return `Melee-only body: \`actor-fire\` is a close-quarters attack (range ~${range}). Close the gap; walls block you like any other body.`;
    }
    if (hasProjectile) {
        const range = Math.round(ai.attackRange ?? 0);
        const rangeLine = range > 0 ? ` (effective range ~${range})` : '';
        return `Ranged body: \`actor-fire\` throws a projectile${rangeLine}. Keep distance and strafe between shots.`;
    }
    if (ai.pellets && ai.pellets > 1) {
        const range = Math.round(ai.attackRange ?? 0);
        return `Hitscan spread: \`actor-fire\` fires ${ai.pellets} pellets at medium range (~${range}). Close to medium distance and line up the target.`;
    }
    const range = Math.round(ai.attackRange ?? 0);
    const rangeLine = range > 0 ? ` (effective range ~${range})` : '';
    return `Hitscan body: \`actor-fire\` fires your native ranged attack${rangeLine}. Keep some distance; \`actor-switch-weapon\` is ignored.`;
}

function ownedWeaponsSize(entity) {
    const owned = entity?.ownedWeapons;
    if (!owned) return 0;
    if (owned instanceof Set) return owned.size;
    if (Array.isArray(owned)) return owned.length;
    if (typeof owned.size === 'number') return owned.size;
    if (typeof owned.length === 'number') return owned.length;
    return 0;
}

function weaponLine(entity) {
    const slot = entity.currentWeapon;
    const w = WEAPONS[slot] || WEAPONS[2];
    const name = w?.name || `slot ${slot}`;
    return `Equipped weapon slot: ${slot} (${name}). Use \`actor-switch-weapon\` for slots you own; \`actor-fire\` fires it.`;
}

function keysLine(entity) {
    const keys = entity.collectedKeys;
    const hasKeys = keys && typeof keys.size === 'number' ? keys.size > 0
        : Array.isArray(keys) ? keys.length > 0
        : false;
    const list = hasKeys ? [...keys].join(', ') : 'none yet';
    return `Keys carried by this body: ${list}. Keys stay with the body that picked them up — possessing a different actor leaves these keys behind on the marine, and key-locked doors check the requesting body's own inventory.`;
}

/**
 * @param {object|null} entity
 * @returns {{ kind: string, label: string, id: string|null, text: string }}
 */
export function rolePromptFor(entity) {
    if (!entity) {
        return {
            kind: 'spectator',
            label: 'Spectator',
            id: null,
            text: 'No playable body right now. Poll `world-get-state` and `world-poll-events`; when a body frees up you may be reassigned on reconnect or map change. If you joined as spectator because the server was full, you may get a `joinChallenge` event — use `session-resolve-join` (MCP) or the browser overlay (WS) to displace an MCP-held body or stay spectating.',
        };
    }

    // Door: camera-only surface. No vitals, no weapon slots, no pickups.
    if (entity.__isDoorEntity) {
        const n = entity.sectorIndex;
        return {
            kind: 'door',
            label: 'Door operator',
            id: `door:${n}`,
            text: "You operate this door's security camera. `actor-set-move` / `actor-turn-by` rotate your view. `doors-approve-request` and `doors-deny-request` only take effect while you are still the current operator — another session can steal the camera. `actor-fire` and `actor-use` do nothing useful here.",
        };
    }

    // Marine: multi-weapon loadout + full pickup inventory + map
    // progression. `kindOfActor` returns 'marine' iff the actor's type
    // matches `MARINE_ACTOR_TYPE`, so one check is enough.
    const kind = kindOfActor(entity);
    if (kind === 'marine') {
        const id = actorIdOf(entity) || 'player';
        return {
            kind: 'marine',
            label: 'Marine',
            id,
            text: [
                'You are the marine: explore, fight, open doors, and finish the map.',
                weaponLine(entity),
                keysLine(entity),
                'Use `actor-set-move` / `actor-turn-by` to move and aim; `actor-use` opens doors and switches in front of you; `actor-stop` clears stuck movement intent.',
                'If another player joins while you hold this body (MCP), they may receive a join challenge — you may be asked via form elicitation to defend your slot; see cssdoom://docs/join-challenge.',
            ].join(' '),
        };
    }

    // Enemy / monster body: single intrinsic attack, no pickup
    // inventory, no weapon switch.
    const label = enemyLabel(entity.type);
    const id = actorIdOf(entity);
    const specific = ownedWeaponsSize(entity) > 1
        ? 'Combatant body. `actor-fire` uses your current attack.'
        : describeMonsterAttacks(entity);
    return {
        kind: 'enemy',
        label,
        id,
        text: `You are a ${label}. ${specific} Use \`actor-set-move\` / \`actor-turn-by\` to navigate; this body has no key inventory of its own, so key-locked doors will refuse you — possess the marine (or whichever body holds the matching key) to pass. If a new player joins when all bodies are taken (MCP), you may be asked to defend this body via elicitation — see cssdoom://docs/join-challenge.`,
    };
}
