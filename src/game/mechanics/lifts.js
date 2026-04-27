/**
 * Lifts
 *
 * Lifts (elevators) work via a dual-system approach:
 *   - Visual movement: The renderer smoothly animates the platform and its contents
 *     between upper and lower positions.
 *   - Physics sync: An ease-in-out interpolation runs each frame to keep
 *     `currentHeight` in sync with the visual animation, so collision detection
 *     and floor-height queries reflect the lift's position at all times.
 *
 * Shaft walls are static geometry spanning the gap between lowerHeight and upperHeight,
 * positioned at upperHeight so they are always visible behind the moving platform.
 *
 * Walk-over triggers use crossing detection: the trigger fires when an eligible
 * actor moves from one side of the trigger linedef to the other, matching the
 * original DOOM behaviour (linuxdoom-1.10/p_spec.c:P_CrossSpecialLine). Eligibility
 * is gated on `movement.canTriggerWalkOver` — marine defaults true, monsters
 * default false (matches today's behavior). Per-actor previous-side state is
 * tracked in `_actorPrevSides` so simultaneous crossings stay sane.
 *
 * Collision edges block actors from walking into the lift shaft from below when
 * the platform is raised, handled externally by the collision system.
 *
 * Lift "ride" behavior is implicit: any actor whose floor sample at `(x, y)`
 * lies inside the lift sector picks up the lift's `currentHeight` via
 * `getFloorHeightAt()`. No per-actor attachment bookkeeping required.
 */

import { LIFT_RAISE_DELAY } from '../constants.js';

import { state } from '../state.js';
import { mapData, currentMap } from '../../data/maps.js';
import { playSound } from '../../audio/audio.js';
import * as renderer from '../../renderer/index.js';
import { markEntityDirty } from '../services.js';

/** Canonical asset id for a lift — matches the SGNL adapter output. */
function liftAssetId(sectorIndex) {
    return `lift:${currentMap || 'unknown'}:${sectorIndex}`;
}

const LIFT_MOVE_DURATION = 1.0; // seconds — must match renderer animation duration

// Cached flat array of { sectorIndex, entry } for zero-alloc iteration in the hot path
let liftEntries = [];

export function initLifts() {
    state.liftState = new Map();
    if (!mapData.lifts) return;

    for (const lift of mapData.lifts) {
        const heightDelta = lift.upperHeight - lift.lowerHeight;
        if (heightDelta <= 0) continue;

        // Build the visual representation via the renderer
        renderer.buildLift(lift);

        state.liftState.set(lift.sectorIndex, {
            sectorIndex: lift.sectorIndex,
            tag: lift.tag,
            upperHeight: lift.upperHeight,
            lowerHeight: lift.lowerHeight,
            collisionEdges: lift.collisionEdges || [],
            currentHeight: lift.upperHeight,
            targetHeight: lift.upperHeight,
            moving: false,
            timer: null,
            oneWay: lift.oneWay || false
        });
    }

    // Cache flat array for zero-alloc iteration in the per-frame hot path
    liftEntries = [];
    state.liftState.forEach((entry, sectorIndex) => {
        liftEntries.push({ sectorIndex, entry });
    });

    // Debug console commands (browser only — skip when running on the server)
    if (typeof window === 'undefined') return;
    window.listTriggers = () => {
        const triggers = mapData.triggers || [];
        triggers.forEach((t, i) => {
            console.log(`[${i}] type=${t.specialType} tag=${t.sectorTag} (${t.start.x},${t.start.y})→(${t.end.x},${t.end.y})${t._triggered ? ' [FIRED]' : ''}`);
        });
        console.log(`${triggers.length} trigger(s). Use triggerLinedef(index) to fire one.`);
    };

    window.triggerLinedef = (index) => {
        const triggers = mapData.triggers || [];
        const trigger = triggers[index];
        if (!trigger) { console.error(`No trigger at index ${index}. Use listTriggers() to see available.`); return; }
        console.log(`Firing trigger [${index}] type=${trigger.specialType} tag=${trigger.sectorTag}`);
        for (let i = 0; i < liftEntries.length; i++) {
            if (liftEntries[i].entry.tag === trigger.sectorTag) {
                activateLift(liftEntries[i].sectorIndex);
            }
        }
    };

    window.activateLift = activateLift;

    window.listLifts = () => {
        liftEntries.forEach(({ sectorIndex, entry }) => {
            console.log(`sector=${sectorIndex} tag=${entry.tag} height=${entry.currentHeight} (${entry.lowerHeight}..${entry.upperHeight}) moving=${entry.moving} oneWay=${entry.oneWay}`);
        });
    };
}

export function activateLift(sectorIndex) {
    const liftState = state.liftState.get(sectorIndex);
    if (!liftState) return;

    // Ignore if already lowered or moving down
    if (liftState.targetHeight === liftState.lowerHeight) return;

    // Begin lowering: set up interpolation state and trigger animation
    liftState.targetHeight = liftState.lowerHeight;
    liftState.moving = true;
    liftState.moveStart = performance.now() / 1000;
    liftState.moveFrom = liftState.currentHeight;
    renderer.setLiftState(sectorIndex, 'lowered');
    playSound('DSPSTART');
    markEntityDirty('lift', liftAssetId(sectorIndex));

    // One-way lifts (e.g. type 36) stay lowered permanently
    if (!liftState.oneWay) {
        clearTimeout(liftState.timer);
        liftState.timer = setTimeout(() => raiseLift(sectorIndex), LIFT_RAISE_DELAY);
    }
}

function raiseLift(sectorIndex) {
    const liftState = state.liftState.get(sectorIndex);
    if (!liftState) return;

    // Begin raising: set up interpolation state and trigger animation
    liftState.targetHeight = liftState.upperHeight;
    liftState.moving = true;
    liftState.moveStart = performance.now() / 1000;
    liftState.moveFrom = liftState.currentHeight;
    renderer.setLiftState(sectorIndex, 'raised');
    playSound('DSPSTOP');
    markEntityDirty('lift', liftAssetId(sectorIndex));
    liftState.timer = null;
}

/**
 * Tick lift heights once per frame. Idempotent: lifts interpolate against
 * `performance.now()`, so calling this multiple times in the same tick (e.g.
 * once per controlled session in `updateMovementFor`) settles to the same
 * value. Renderer easing is approximated with a smoothstep curve that closely
 * tracks the cubic-bezier (0.42, 0, 0.58, 1) the CSS animation uses.
 *
 * NOTE: this used to take the caller's frame timestamp, but the browser ships
 * `performance.now()` (RAF) while the server ships `Date.now()`. Since
 * `activateLift`/`raiseLift` stamp `moveStart` with `performance.now()`, mixing
 * the two clocks made `elapsedSeconds` astronomical and snapped lifts to their
 * target on the very next physics tick — leaving actors walled in by the
 * shaft's collision edges while the visual platform was still animating up.
 * Using `performance.now()` directly keeps both ends honest.
 */
export function updateLifts() {
    const currentTimeSeconds = performance.now() / 1000;
    for (let index = 0, count = liftEntries.length; index < count; index++) {
        const { sectorIndex, entry: liftState } = liftEntries[index];
        if (!liftState.moving) continue;
        markEntityDirty('lift', liftAssetId(sectorIndex));

        const elapsedSeconds = currentTimeSeconds - liftState.moveStart;
        const interpolation = Math.min(1, elapsedSeconds / LIFT_MOVE_DURATION);

        const t = interpolation;
        const easedInterpolation = t * t * (3 - 2 * t);

        liftState.currentHeight = liftState.moveFrom + (liftState.targetHeight - liftState.moveFrom) * easedInterpolation;

        if (interpolation >= 1) {
            liftState.currentHeight = liftState.targetHeight;
            liftState.moving = false;
        }
    }
}

/**
 * Each frame: for every actor whose `movement.canTriggerWalkOver === true`,
 * check whether it crossed any walk-over trigger linedef. Marine defaults true,
 * monsters default false — same encounter flow as today, just attribute-gated
 * so future monster designs can opt in.
 *
 * Crossing detection (linuxdoom-1.10/p_spec.c:P_CrossSpecialLine): fires when
 * the actor moves from one side of the trigger linedef to the other.
 * W1 types (10, 53, 36) fire once globally; WR types (88, 120) fire on every
 * crossing. Per-actor previous-side state lives in `trigger._actorPrevSides`.
 */
export function checkWalkOverTriggers() {
    const triggers = mapData.triggers;
    if (!triggers) return;

    for (let actorIdx = 0, alen = state.actors.length; actorIdx < alen; actorIdx++) {
        const actor = state.actors[actorIdx];
        if (!actor) continue;
        if (actor.collected || (actor.hp ?? 0) <= 0) continue;
        if (!actor.movement?.canTriggerWalkOver) continue;

        for (let index = 0, count = triggers.length; index < count; index++) {
            const trigger = triggers[index];

            // W1 triggers only fire once
            if (trigger._triggered) continue;

            const dx = trigger.end.x - trigger.start.x;
            const dy = trigger.end.y - trigger.start.y;
            const side = (actor.x - trigger.start.x) * dy - (actor.y - trigger.start.y) * dx;
            const currentSide = side > 0;

            if (!trigger._actorPrevSides) trigger._actorPrevSides = new WeakMap();
            const prevSides = trigger._actorPrevSides;
            const previousSide = prevSides.get(actor);
            prevSides.set(actor, currentSide);

            // First frame this actor is observed: just record the side, don't fire
            if (previousSide === undefined) continue;
            if (previousSide === currentSide) continue;

            // Mark W1 (one-shot) types so they don't fire again
            if (trigger.specialType === 10 || trigger.specialType === 53 || trigger.specialType === 36) {
                trigger._triggered = true;
            }

            // Activate all lifts whose tag matches this trigger's sector tag
            for (let liftIndex = 0, liftCount = liftEntries.length; liftIndex < liftCount; liftIndex++) {
                if (liftEntries[liftIndex].entry.tag === trigger.sectorTag) {
                    activateLift(liftEntries[liftIndex].sectorIndex);
                }
            }
        }
    }
}
