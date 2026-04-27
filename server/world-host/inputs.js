/**
 * Server connection input adapter for the shared engine.
 */

import { state } from '../../src/engine/state.js';
import { getControlledFor, possessFor } from '../../src/engine/possession.js';
import { equipWeapon, fireWeaponFor } from '../../src/engine/combat/weapons.js';
import { tryOpenDoor, resolveDoorRequest } from '../../src/engine/mechanics/doors.js';
import { tryUseSwitch } from '../../src/engine/mechanics/switches.js';
import { canSwitchWeapons } from '../../src/engine/actors/capabilities.js';

import { entityId, resolveEntity } from '../assignment.js';
import { listPlayerConnections } from '../connections.js';
import { handleSwitchExit } from '../world/maps.js';
import { queueRoleChange } from '../world/roles.js';

export function processConnectionInputs() {
    for (const conn of listPlayerConnections()) {
        const inp = conn.input;
        if (inp.switchWeapon) {
            const body = getControlledFor(conn.sessionId);
            if (canSwitchWeapons(body)) {
                equipWeapon(inp.switchWeapon);
            }
            inp.switchWeapon = null;
        }
        if (inp.use) {
            const body = getControlledFor(conn.sessionId);
            if (body) {
                tryOpenDoor(body);
                void tryUseSwitch(body).then(handleSwitchExit);
            }
            inp.use = false;
        }
        if (inp.bodySwap) {
            const target = resolveEntity(inp.bodySwap.targetId);
            if (target && possessFor(conn.sessionId, target)) {
                conn.controlledId = entityId(target);
                queueRoleChange(conn.sessionId);
            }
            inp.bodySwap = null;
        }
        if (inp.doorDecision) {
            const { sectorIndex, requestId, decision } = inp.doorDecision;
            const doorEntry = state.doorState.get(sectorIndex);
            const doorEntity = doorEntry?.doorEntity || null;
            if (doorEntity && getControlledFor(conn.sessionId) === doorEntity) {
                resolveDoorRequest(sectorIndex, requestId, decision);
            }
            inp.doorDecision = null;
        }
        if (inp.fireHeld) {
            fireWeaponFor(conn.sessionId);
        }
    }
}

export function collectSessionInputs() {
    const out = new Map();
    for (const conn of listPlayerConnections()) {
        out.set(conn.sessionId, conn.input);
    }
    return out;
}
