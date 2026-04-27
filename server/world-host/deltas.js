/**
 * Per-tick snapshot delta builder.
 */

import {
    diffAndCommit,
    serializeCurrentWorld,
} from '../world/snapshots.js';
import { drainRendererEvents, drainSoundEvents } from './hosts.js';
import { getCurrentTick } from './loop.js';

export function buildDeltasForTick() {
    const rendererEvents = drainRendererEvents();
    const soundEvents = drainSoundEvents();
    const current = serializeCurrentWorld();
    const tick = getCurrentTick();
    const serverTime = Date.now();

    return (conn) => diffAndCommit(conn, current, {
        tick,
        serverTime,
        rendererEvents,
        soundEvents,
    });
}
