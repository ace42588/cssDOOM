/**
 * Wire protocol for the multiplayer server.
 *
 * All messages are JSON objects with a `type` discriminator. The shapes
 * below are the authoritative reference; both the server (`server/`) and
 * the client (`index.js`) should stick to them.
 *
 * ── Client → Server ───────────────────────────────────────────────────
 *
 *   { type: 'input', seq, input: {
 *       moveX: number  // -1..1 strafe
 *       moveY: number  // -1..1 forward/back
 *       turn:  number  // -1..1 yaw rate
 *       turnDelta: number  // radians, absolute yaw delta this frame
 *       run:   boolean
 *       fireHeld: boolean
 *       use:   boolean  // edge-triggered "open door / hit switch"
 *       bodySwap: { targetId: string | 'player' } | null
 *       doorDecision: { sectorIndex: number, requestId: number,
 *                       decision: 'open' | 'ignore' } | null
 *       switchWeapon: number | null  // slot number if the client wants to change
 *     } }
 *
 *   { type: 'pong', t } — reply to a server ping.
 *
 * ── Server → Client ───────────────────────────────────────────────────
 *
 *   { type: 'welcome', sessionId, role, controlledId, followTargetId,
 *                      mapName, tickRateHz, serverTime }
 *
 *   { type: 'roleChange', role, controlledId, followTargetId }
 *
 *   { type: 'mapLoad', mapName, mapData }
 *      (The full map JSON is shipped so clients can build their scene
 *      without needing to fetch it separately.)
 *
 *   { type: 'snapshot', tick, serverTime,
 *       role, controlledId, followTargetId,
 *       player: { x, y, z, angle, floorHeight, health, armor, armorType,
 *                 ammo, maxAmmo, currentWeapon, ownedWeapons[],
 *                 collectedKeys[], powerups{}, isDead, isAiDead, isFiring },
 *       things: [{ id, x, y, z, floorHeight, angle, viewAngle, facing,
 *                  type, hp, maxHp, collected, aiState, __sessionId? }],
 *       projectiles: [{ id, x, y, z, type, sprite }],
 *       doors: [{ sectorIndex, open, passable, keyRequired,
 *                 operatorSessionId: string | null,
 *                 pendingRequests: [{ id, interactorLabel,
 *                                     interactorDetails, approachSide }] }],
 *       lifts: [{ sectorIndex, tag, currentHeight, targetHeight,
 *                 lowerHeight, upperHeight, moving, oneWay }],
 *       crushers: [{ sectorIndex, active, direction, currentHeight,
 *                    topHeight, crushHeight, damageTimer }],
 *       rendererEvents: Array<{ fn: string, args: any[] }>,
 *       soundEvents:   Array<string>,
 *   }
 *
 *   { type: 'bye', reason }
 */

export const MSG = {
    HELLO: 'hello',
    INPUT: 'input',
    PONG: 'pong',
    WELCOME: 'welcome',
    ROLE_CHANGE: 'roleChange',
    MAP_LOAD: 'mapLoad',
    SNAPSHOT: 'snapshot',
    BYE: 'bye',
};

export const ROLE = {
    PLAYER: 'player',
    SPECTATOR: 'spectator',
};

/** Default input state used before the first packet arrives. */
export function emptyInput() {
    return {
        moveX: 0,
        moveY: 0,
        turn: 0,
        turnDelta: 0,
        run: false,
        fireHeld: false,
        use: false,
        bodySwap: null,
        doorDecision: null,
        switchWeapon: null,
    };
}

/** Merge `partial` on top of `base`, clamping ranges and discarding junk. */
export function sanitizeInput(partial) {
    const out = emptyInput();
    if (!partial || typeof partial !== 'object') return out;
    out.moveX = clamp(Number(partial.moveX) || 0, -1, 1);
    out.moveY = clamp(Number(partial.moveY) || 0, -1, 1);
    out.turn  = clamp(Number(partial.turn)  || 0, -1, 1);
    out.turnDelta = Number(partial.turnDelta) || 0;
    out.run = Boolean(partial.run);
    out.fireHeld = Boolean(partial.fireHeld);
    out.use = Boolean(partial.use);
    if (partial.bodySwap && typeof partial.bodySwap === 'object') {
        out.bodySwap = { targetId: partial.bodySwap.targetId ?? null };
    }
    if (partial.doorDecision && typeof partial.doorDecision === 'object') {
        const sectorIndex = Number(partial.doorDecision.sectorIndex);
        const requestId = Number(partial.doorDecision.requestId);
        const decision = partial.doorDecision.decision === 'open' ? 'open' : 'ignore';
        if (Number.isFinite(sectorIndex) && Number.isFinite(requestId)) {
            out.doorDecision = { sectorIndex, requestId, decision };
        }
    }
    if (Number.isFinite(partial.switchWeapon)) {
        out.switchWeapon = Math.max(1, Math.min(9, Math.floor(partial.switchWeapon)));
    }
    return out;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
