/**
 * Canonical runtime id strings: `actor:<slot>`, `thing:<index>`, `door:<sector>`.
 * Marine is always `actor:0`. Legacy alias `player` is still accepted by parsers.
 */

import { getMarine, state } from '../state.js';
import { getThingIndex, getActorIndex } from '../things/registry.js';

/** Stable id for an entity (marine = `actor:0`, things = `thing:<idx>`, doors = `door:<sector>`). */
export function formatRuntimeId(entity) {
    if (!entity) return null;
    if (entity === getMarine()) return 'actor:0';
    if (entity.__isDoorEntity) return `door:${entity.sectorIndex}`;
    const aIdx = getActorIndex(entity);
    if (aIdx >= 0) return `actor:${aIdx}`;
    const idx = getThingIndex(entity);
    return idx >= 0 ? `thing:${idx}` : null;
}

export function resolveRuntimeId(id) {
    if (!id) return null;
    if (id === 'player') return getMarine();
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
    if (lower === 'marine' || lower === 'player') return { bodySwap: 'actor:0', requested: 'actor:0' };
    const thingM = /^thing:(\d+)$/i.exec(s);
    if (thingM) return { bodySwap: `thing:${thingM[1]}`, requested: `thing:${thingM[1]}` };
    const doorM = /^door:(\d+)$/i.exec(s);
    if (doorM) return { bodySwap: `door:${doorM[1]}`, requested: `door:${doorM[1]}` };
    const actorM = /^actor:(\d+)$/i.exec(s);
    if (actorM) return { bodySwap: `actor:${actorM[1]}`, requested: `actor:${actorM[1]}` };
    return null;
}
