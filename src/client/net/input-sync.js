import { collectInput, input } from '../../engine/ports/input.js';
import {
    LOCAL_SESSION,
    getControlledFor,
} from '../../engine/possession.js';
import { RUN_MULTIPLIER, TURN_SPEED } from '../../engine/constants.js';

let inputSeq = 0;
let lastInputFrameTime = 0;

const pendingFlags = {
    use: false,
    bodySwap: null,
    doorDecision: null,
    switchWeapon: null,
};

export function buildAndSendInputFrame({ isOpen, sendJson }) {
    collectInput();

    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const deltaTime = lastInputFrameTime ? Math.min(0.1, (now - lastInputFrameTime) / 1000) : 0;
    lastInputFrameTime = now;

    predictLocalDoorView(deltaTime);

    if (!isOpen()) {
        input.turnDelta = 0;
        return;
    }

    sendJson({
        type: 'input',
        seq: ++inputSeq,
        input: {
            moveX: input.moveX,
            moveY: input.moveY,
            turn: input.turn,
            turnDelta: input.turnDelta,
            run: input.run,
            fireHeld: input.fireHeld,
            use: drainFlag('use'),
            bodySwap: drainFlag('bodySwap'),
            doorDecision: drainFlag('doorDecision'),
            switchWeapon: drainFlag('switchWeapon'),
        },
    });
    input.turnDelta = 0;
}

function predictLocalDoorView(deltaTime) {
    const entity = getControlledFor(LOCAL_SESSION);
    if (!entity || !entity.__isDoorEntity) return;
    const turnSpeed = input.run ? TURN_SPEED * RUN_MULTIPLIER : TURN_SPEED;
    const delta = (input.turn || 0) * turnSpeed * deltaTime + (input.turnDelta || 0);
    if (delta === 0) return;
    const angle = (entity.viewAngle ?? 0) + delta;
    entity.viewAngle = angle;
    entity.facing = angle + Math.PI / 2;
}

function drainFlag(name) {
    const value = pendingFlags[name];
    pendingFlags[name] = name === 'use' ? false : null;
    return value;
}

export function pressUse() { pendingFlags.use = true; }
export function requestBodySwap(targetId) { pendingFlags.bodySwap = { targetId }; }
export function requestDoorDecision(sectorIndex, requestId, decision) {
    pendingFlags.doorDecision = { sectorIndex, requestId, decision };
}
export function requestWeaponSwitch(slot) { pendingFlags.switchWeapon = slot; }

