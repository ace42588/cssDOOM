/**
 * Canonical runtime id strings: `actor:<slot>`, `thing:<index>`, `door:<sector>`.
 *
 * Every actor — including the marine — formats to its live `actorIndex`
 * (`actor:<slot>`). The marine is spawned first, so in practice it lands at
 * `actor:0`, but the id string is derived from the slot, not from a special
 * marine branch. `'player'` is still accepted as an input alias by
 * `resolveRuntimeId` / `normalizePossessTargetId` so external callers
 * (MCP, sticky reconnect) can keep using that spelling.
 */

import { state, getMarineActor } from '../state.js';
import { getThingIndex, getActorIndex } from '../things/registry.js';

/** Stable id for an entity (`actor:<slot>`, `thing:<index>`, or `door:<sector>`). */
export function formatRuntimeId(entity) {
    if (!entity) return null;
    if (entity.__isDoorEntity) return `door:${entity.sectorIndex}`;
    const aIdx = getActorIndex(entity);
    if (aIdx >= 0) return `actor:${aIdx}`;
    const idx = getThingIndex(entity);
    return idx >= 0 ? `thing:${idx}` : null;
}

export function resolveRuntimeId(id) {
    if (!id) return null;
    if (id === 'player') return getMarineActor();
    const actorM = /^actor:(\d+)$/i.exec(id);
    if (actorM) {
        const slot = Number(actorM[1]);
        return state.actors[slot] ?? null;
    }
    if (typeof id === 'string' && id.startsWith('thing:')) {
        const idx = Number(id.slice('thing:'.length));
        return state.things[idx] || null;
    }
    if (typeof id === 'string' && id.startsWith('door:')) {
        const sectorIndex = Number(id.slice('door:'.length));
        const entry = state.doorState.get(sectorIndex);
        return entry?.doorEntity || null;
    }
    return null;
}

/**
 * MCP / edge normalizer for body-swap targets.
 * @returns {{ bodySwap: string, requested: string } | null}
 */
export function normalizePossessTargetId(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    const lower = s.toLowerCase();
    if (lower === 'marine' || lower === 'player') {
        const marine = getMarineActor();
        const id = marine ? formatRuntimeId(marine) : null;
        return id ? { bodySwap: id, requested: id } : null;
    }
    const thingM = /^thing:(\d+)$/i.exec(s);
    if (thingM) return { bodySwap: `thing:${thingM[1]}`, requested: `thing:${thingM[1]}` };
    const doorM = /^door:(\d+)$/i.exec(s);
    if (doorM) return { bodySwap: `door:${doorM[1]}`, requested: `door:${doorM[1]}` };
    const actorM = /^actor:(\d+)$/i.exec(s);
    if (actorM) return { bodySwap: `actor:${actorM[1]}`, requested: `actor:${actorM[1]}` };
    return null;
}
