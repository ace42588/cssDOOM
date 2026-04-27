/**
 * Global door access gating mode. Authoritative on the server; read through
 * `getDoorControlMode` passed into `setGameServices()` from `server/index.js`.
 * Admin REST (`PUT /admin/door-control-mode`) calls `setDoorControlMode` after
 * validating the mode string.
 */

import { DOOR_CONTROL_MODE } from '../../src/engine/constants.js';

const VALID = new Set(Object.values(DOOR_CONTROL_MODE));

let current = (() => {
    const env = process.env.DOOR_CONTROL_MODE?.trim();
    return env && VALID.has(env) ? env : DOOR_CONTROL_MODE.PLAYER;
})();

export function getDoorControlMode() {
    return current;
}

export function setDoorControlMode(mode) {
    if (!VALID.has(mode)) throw new Error(`Invalid door control mode: ${mode}`);
    current = mode;
}
