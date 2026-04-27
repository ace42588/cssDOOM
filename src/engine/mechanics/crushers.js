/**
 * Crushers
 *
 * Ceiling crushers that cycle between raised and lowered positions, damaging
 * any hazard-susceptible actor caught underneath.
 *
 * Based on: linuxdoom-1.10/p_ceilng.c:EV_DoCeiling(), T_MoveCeiling()
 * Accuracy: Approximation — same raise-then-crush cycle, but we use linear
 * interpolation instead of DOOM's fixed-point per-tic movement. Damage is
 * applied once per second while crushed (DOOM applies 10 damage per tic-cycle).
 *
 * Visual approach: The renderer groups upper walls belonging to the crusher
 * sector into an animated container that moves between the raised and crushed
 * heights. Ceiling surfaces (if any) are also included.
 *
 * Crusher types:
 * - crushAndRaise: ceiling raises to highest neighbor ceiling, then lowers to
 *   floor + 8, repeating indefinitely. Activated by switch (SR type 63) or
 *   walk-over trigger (W1/WR types 6, 25, 73, 77).
 *
 * Hazard scope: any live actor in `state.actors` whose
 * `movement.hazardSusceptible === true` can be crushed. Marine defaults true,
 * monsters default false (matches today's behavior); damage timers are tracked
 * per-actor so multiple susceptible actors in the same crusher each tick
 * independently.
 */

import { state } from '../state.js';
import { mapData, currentMap } from '../data/maps.js';
import { getSectorAt } from '../physics/queries.js';
import { applyDamage } from '../combat/damage.js';
import * as renderer from '../ports/renderer.js';
import { markEntityDirty } from '../services.js';

/** Canonical asset id for a crusher — matches the SGNL adapter output. */
function crusherAssetId(sectorIndex) {
    return `crusher:${currentMap || 'unknown'}:${sectorIndex}`;
}

const CRUSHER_SLOW_SPEED = 32;  // Map units per second (DOOM: 1 unit per tic at 35fps ≈ 35/s, we use 32)
const CRUSHER_FAST_SPEED = 64;  // Fast crushers move at double speed
// Based on: linuxdoom-1.10/p_spec.c:T_MoveCeiling() — 10 damage every 4 tics
const CRUSHER_DAMAGE = 10;
const CRUSHER_DAMAGE_INTERVAL = 4 / 35; // 4 tics ≈ 0.114 seconds
// Crush is applied when the gap between the moving ceiling and the actor's
// floor drops below the actor's standing height. Marine height = 56 minus a
// small slop for the eye-vs-top gap; monsters use their own `height`.
const CRUSH_HEIGHT_SLOP = 15;

let crusherEntries = [];

export function initCrushers() {
    state.crusherState = new Map();
    crusherEntries = [];
    if (!mapData.crushers) return;

    for (const crusher of mapData.crushers) {
        const travelDistance = crusher.topHeight - crusher.crushHeight;
        if (travelDistance <= 0) continue;

        // Build the visual representation via the renderer
        renderer.buildCrusher(crusher);

        const entry = {
            sectorIndex: crusher.sectorIndex,
            topHeight: crusher.topHeight,
            crushHeight: crusher.crushHeight,
            speed: crusher.speed === 'fast' ? CRUSHER_FAST_SPEED : CRUSHER_SLOW_SPEED,
            currentHeight: crusher.topHeight,
            direction: -1,
            active: false,
            // Per-actor damage timers so multiple hazard-susceptible actors in
            // the same crusher each tick at the canonical interval.
            actorDamageTimers: new Map(),
        };

        state.crusherState.set(crusher.sectorIndex, entry);
        crusherEntries.push(entry);
    }
}

/**
 * Activates a crusher by sector index. Called when an actor triggers the
 * switch or walk-over linedef that starts the crusher.
 */
export function activateCrusher(sectorIndex) {
    const entry = state.crusherState.get(sectorIndex);
    if (!entry || entry.active) return;
    entry.active = true;
    entry.direction = -1; // start by lowering
    markEntityDirty('crusher', crusherAssetId(sectorIndex));
}

/**
 * Updates all active crushers each frame. Moves the ceiling height, updates
 * the renderer with the current offset, and damages every hazard-susceptible
 * actor currently inside a crushed sector.
 */
export function updateCrushers(deltaTime) {
    for (let i = 0; i < crusherEntries.length; i++) {
        const entry = crusherEntries[i];
        if (!entry.active) continue;
        markEntityDirty('crusher', crusherAssetId(entry.sectorIndex));

        const moveAmount = entry.speed * deltaTime * entry.direction;
        entry.currentHeight += moveAmount;

        // Reverse direction at limits
        if (entry.currentHeight <= entry.crushHeight) {
            entry.currentHeight = entry.crushHeight;
            entry.direction = 1; // start raising
        } else if (entry.currentHeight >= entry.topHeight) {
            entry.currentHeight = entry.topHeight;
            entry.direction = -1; // start lowering
        }

        const offset = entry.topHeight - entry.currentHeight;
        renderer.setCrusherOffset(entry.sectorIndex, offset);

        checkCrusherDamage(entry, deltaTime);
    }
}

/**
 * Damage every hazard-susceptible actor currently inside this crusher's sector
 * whose ceiling clearance has dropped below their height. Per-actor timers
 * accumulate independently; actors that leave the sector lose their timer so
 * a re-entry restarts the interval.
 */
function checkCrusherDamage(entry, deltaTime) {
    const timers = entry.actorDamageTimers;
    const presentActors = new Set();

    for (let i = 0, len = state.actors.length; i < len; i++) {
        const actor = state.actors[i];
        if (!actor) continue;
        if (actor.collected || (actor.hp ?? 0) <= 0) continue;
        if (!actor.movement?.hazardSusceptible) continue;

        const clearance = entry.currentHeight - actor.floorHeight;
        const standingHeight = (actor.height ?? 0) - CRUSH_HEIGHT_SLOP;
        if (clearance > standingHeight) continue;

        const sector = getSectorAt(actor.x, actor.y);
        if (!sector || sector.sectorIndex !== entry.sectorIndex) continue;

        presentActors.add(actor);
        const accumulated = (timers.get(actor) ?? 0) + deltaTime;
        if (accumulated >= CRUSHER_DAMAGE_INTERVAL) {
            timers.set(actor, accumulated - CRUSHER_DAMAGE_INTERVAL);
            applyDamage(actor, CRUSHER_DAMAGE, null, { kind: 'crusher' });
        } else {
            timers.set(actor, accumulated);
        }
    }

    // Drop timers for actors that left the crusher (or died) so the next
    // entry starts a fresh interval and the map doesn't grow unbounded.
    for (const tracked of timers.keys()) {
        if (!presentActors.has(tracked)) timers.delete(tracked);
    }
}
