/**
 * Unified damage pipeline: one `applyDamage(target, amount, sourceActor, {kind})`
 * routes armor/skill-variance/pain/infighting via capability blocks and the
 * target's `onDeath.mode` (marine → game-over, monster → corpse, barrel →
 * explode). No marine-special branch and no `damageEnemy` / `damagePlayer`
 * wrappers — every caller feeds the unified entry point.
 */

import { state } from '../state.js';
import { playSound } from '../ports/audio.js';
import { currentMap } from '../data/maps.js';
import { getSectorHazardAt } from '../physics/queries.js';
import * as renderer from '../ports/renderer.js';
import { flushNow, markPlayerDirty } from '../services.js';
import {
    getSessionIdControlling,
    isHumanControlled,
    onPossessedDeath,
} from '../possession.js';
import { forEachRadiusDamageTarget } from './radius.js';
import { setEnemyState } from '../ai/state.js';
import { getThingIndex } from '../things/registry.js';
import { INFIGHTING_THRESHOLD, BARREL_EXPLOSION_RADIUS } from '../constants.js';

// ============================================================================
// Damage application
// ============================================================================

/**
 * Apply `amount` damage to `target`, attributed to `sourceActor` (may be null
 * for sector/environment damage). All behaviour keys off the target's
 * capability blocks:
 *   - `target.defense.incomingDamageMultiplier` — skill variance baked in at spawn.
 *   - `target.armor` / `target.armorType`       — marine-shaped actors absorb.
 *   - `target.ai.painChance`                    — enemy pain animation odds.
 *   - `target.ai.threshold` / `.target`          — infighting retarget.
 *   - `target.onDeath.mode`                      — death routing (gameover / corpse / explode).
 *   - `target.powerups.invulnerability`          — marine invulnerability bypass.
 *
 * `context.kind` is an optional tag describing the damage source (`'sector'`,
 * `'melee'`, `'hitscan'`, `'projectile'`, `'radius'`); currently informational.
 */
export function applyDamage(target, amount, sourceActor = null, context = {}) {
    if (!target) return;
    if (target.collected) return;
    if ((target.hp ?? 0) <= 0) return;
    if (target.deathMode) return;
    if (target.powerups?.invulnerability > 0) return;

    const multiplier = target.defense?.incomingDamageMultiplier ?? 1;
    let damage = Math.floor(amount * multiplier);
    if (damage <= 0) return;

    // Record last-damaging session for killer → marine promotion on restart.
    if (sourceActor) {
        const attackerSession = getSessionIdControlling(sourceActor);
        if (attackerSession) target.lastDamagedBySessionId = attackerSession;
    }

    // Armor absorption (marine-shaped loadout only).
    if (target.armorType) {
        let saved = target.armorType === 1
            ? Math.floor(damage / 3)
            : Math.floor(damage / 2);
        if (target.armor <= saved) {
            saved = target.armor;
            target.armorType = 0;
        }
        target.armor -= saved;
        damage -= saved;
    }

    target.hp -= damage;

    const deathMode = target.onDeath?.mode;
    if (target.hp <= 0) {
        target.hp = 0;
        routeDeath(target, sourceActor, deathMode);
        return;
    }

    // Target survived — route pain / infighting / SFX.
    const controllingSession = getSessionIdControlling(target);
    if (controllingSession) {
        // Any session-controlled actor (marine or possessed monster)
        // gets the first-person hurt flash + pain sound scoped to its
        // own session. The AI pain routing still runs below so the
        // infighting/pain-state machine behaves the same whether the
        // body is human-driven or not.
        markPlayerDirty();
        renderer.triggerViewerFlash('hurt', controllingSession);
        playSound(deathMode === 'gameover' ? 'DSPLPAIN' : 'DSPOPAIN', controllingSession);
    } else if (deathMode === 'gameover') {
        // Headless / AI-driven marine — no viewer to notify, just the
        // world-sound variant.
        markPlayerDirty();
        playSound('DSPOPAIN');
    }

    if (target.ai) {
        routeEnemyPain(target, sourceActor, context);
    }
    // Barrels and other shootable things have no pain behaviour.
}

function routeEnemyPain(target, sourceActor, context) {
    if (target.type !== 2035) playSound('DSPOPAIN');

    const rng = context.random ?? Math.random;
    const painTriggered = target.ai && target.ai.painChance !== undefined
        && rng() * 256 < target.ai.painChance;

    if (sourceActor && sourceActor !== target && target.ai.threshold <= 0) {
        target.ai.target = sourceActor;
        target.ai.threshold = INFIGHTING_THRESHOLD;
    }

    if (painTriggered) setEnemyState(target, 'pain');
}

function routeDeath(target, sourceActor, deathMode) {
    markPlayerDirty();
    const thingIndex = getThingIndex(target);

    if (deathMode === 'gameover') {
        deathMarine(target);
        return;
    }

    // Monsters, barrels, and anything else routed through registered
    // actors / state.things: mark collected, trigger renderer death,
    // then route onDeath-specific side effects.
    target.collected = true;
    renderer.killEnemy(thingIndex, target.type);

    if (isHumanControlled(target)) {
        onPossessedDeath(target);
    }

    if (deathMode === 'explode') {
        playSound('DSBAREXP');
        barrelExplosion(target, sourceActor);
        return;
    }

    // Default `corpse` path (also catches 'gib' / future modes that share
    // the normal enemy death announcement).
    playSound('DSPODTH1');

    // Based on: linuxdoom-1.10/p_mobj.c:P_NightmareRespawn()
    // Nightmare: enemies respawn 12 seconds after death.
    if (state.skillLevel === 5 && target.ai) {
        target.respawnTimer = 12;
    }
    // Based on: linuxdoom-1.10/p_enemy.c:A_BossDeath()
    // E1M8: when all Barons (type 3003) are dead, lower tag 666 sector floor.
    if (target.type === 3003 && currentMap === 'E1M8') {
        checkBossDeath();
    }
}

function deathMarine(target) {
    const controllingSession = getSessionIdControlling(target);
    const playerIsControlled = isHumanControlled(target);

    if (playerIsControlled) {
        target.deathMode = 'gameover';
        target.deathTime = performance.now();
        if (controllingSession) {
            renderer.setViewerPlayerDead(true, controllingSession);
            playSound('DSPLDETH', controllingSession);
        } else {
            renderer.setPlayerDead(true);
            playSound('DSPLDETH');
        }
        void flushNow();
    } else {
        // Marine body died while AI-controlled — mark unpossessable and let
        // possession cycle pick a follow-up body without firing the local
        // game-over flow.
        target.deathMode = 'ai';
        playSound('DSPLDETH');
        onPossessedDeath(target);
    }
}

// ============================================================================
// Barrel explosion (routed on death via onDeath.mode === 'explode')
// ============================================================================

function barrelExplosion(barrel, sourceActor) {
    forEachRadiusDamageTarget(barrel, BARREL_EXPLOSION_RADIUS, (target, damage) => {
        if (target === barrel) return;
        applyDamage(target, damage, sourceActor, { kind: 'radius' });
    });
}

// ============================================================================
// E1M8 Boss Death Trigger
// ============================================================================

function checkBossDeath() {
    for (let i = 0, len = state.actors.length; i < len; i++) {
        const t = state.actors[i];
        if (t && t.type === 3003 && !t.collected) return;
    }
    for (let i = 0, len = state.things.length; i < len; i++) {
        const t = state.things[i];
        if (t && t.type === 3003 && !t.collected) return;
    }
    renderer.lowerTaggedFloor(666);
}

// ============================================================================
// Sector damage — iterates every hazard-susceptible actor
// ============================================================================

/**
 * Tick sector hazards against every actor whose `movement.hazardSusceptible`
 * is true. Each actor keeps its own `sectorDamageTimer` so overlapping
 * hazards don't race across actors.
 */
export function checkSectorDamage(deltaTime) {
    for (let i = 0, len = state.actors.length; i < len; i++) {
        const actor = state.actors[i];
        if (!actor) continue;
        if (actor.movement?.hazardSusceptible !== true) continue;
        if ((actor.hp ?? 0) <= 0 || actor.deathMode || actor.collected) {
            actor.sectorDamageTimer = 0;
            continue;
        }

        const { damage: sectorDamageAmount, specialType } = getSectorHazardAt(actor.x, actor.y);
        const radsuitBypassed = actor.powerups?.radsuit
            && (specialType === 4 || specialType === 16)
            && Math.random() < 5 / 256;

        if (sectorDamageAmount > 0 && (!actor.powerups?.radsuit || radsuitBypassed)) {
            actor.sectorDamageTimer = (actor.sectorDamageTimer || 0) + deltaTime;
            if (actor.sectorDamageTimer >= 32 / 35) {
                actor.sectorDamageTimer -= 32 / 35;
                applyDamage(actor, sectorDamageAmount, null, { kind: 'sector' });
            }
        } else {
            actor.sectorDamageTimer = 0;
        }
    }
}
