/**
 * Fixed-timestep authoritative simulation loop.
 */

import { updateGameMulti } from '../../src/engine/index.js';

import { tickIdleChecks } from '../idle.js';
import {
    queueRoleChange,
    reconcileDeadControllers,
    syncPlayerControlledIdsFromPossession,
} from '../world/roles.js';
import { collectSessionInputs, processConnectionInputs } from './inputs.js';
import { checkMarineLossRestart } from './marine-loss.js';

const TICK_RATE_HZ = 70;
const TICK_MS = 1000 / TICK_RATE_HZ;
const SNAPSHOT_DIVISOR = 2;

let tickNumber = 0;
let loopTimer = null;
let lastTickTime = 0;

export function startLoop({ onTick } = {}) {
    if (loopTimer) return;
    lastTickTime = Date.now();
    tickNumber = 0;
    loopTimer = setInterval(() => {
        const now = Date.now();
        const dt = Math.min((now - lastTickTime) / 1000, TICK_MS * 4 / 1000);
        lastTickTime = now;

        processConnectionInputs();
        updateGameMulti(dt, now, collectSessionInputs());
        syncPlayerControlledIdsFromPossession();
        reconcileDeadControllers();
        checkMarineLossRestart(now);
        tickIdleChecks(now, queueRoleChange);
        tickNumber += 1;

        if (onTick) {
            const shouldSnapshot = (tickNumber % SNAPSHOT_DIVISOR) === 0;
            onTick({ tickNumber, now, shouldSnapshot });
        }
    }, TICK_MS);
}

export function stopLoop() {
    if (!loopTimer) return;
    clearInterval(loopTimer);
    loopTimer = null;
}

export function getTickRateHz() {
    return TICK_RATE_HZ;
}

export function getCurrentTick() {
    return tickNumber;
}
