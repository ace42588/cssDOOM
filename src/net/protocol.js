import { z } from 'zod';

export const MSG = {
    HELLO: 'hello',
    INPUT: 'input',
    PONG: 'pong',
    WELCOME: 'welcome',
    ROLE_CHANGE: 'roleChange',
    MAP_LOAD: 'mapLoad',
    MAP_LOAD_COMPLETE: 'mapLoadComplete',
    LOAD_MAP_REQUEST: 'loadMapRequest',
    SNAPSHOT: 'snapshot',
    NOTICE: 'notice',
    BYE: 'bye',
};

export const ALLOWED_MAPS = new Set([
    'E1M1', 'E1M2', 'E1M3', 'E1M4', 'E1M5', 'E1M6', 'E1M7', 'E1M8', 'E1M9',
]);

export const ROLE = {
    PLAYER: 'player',
    SPECTATOR: 'spectator',
};

export const DoorDecisionSchema = z.object({
    sectorIndex: z.coerce.number().finite(),
    requestId: z.coerce.number().finite(),
    decision: z.enum(['open', 'ignore']).catch('ignore'),
});

export const BodySwapSchema = z.object({
    targetId: z.any().nullable(),
});

export const InputPayloadSchema = z.object({
    moveX: z.coerce.number().finite().catch(0).transform((v) => clamp(v, -1, 1)),
    moveY: z.coerce.number().finite().catch(0).transform((v) => clamp(v, -1, 1)),
    turn: z.coerce.number().finite().catch(0).transform((v) => clamp(v, -1, 1)),
    turnDelta: z.coerce.number().finite().catch(0),
    run: z.coerce.boolean().catch(false),
    fireHeld: z.coerce.boolean().catch(false),
    use: z.coerce.boolean().catch(false),
    bodySwap: BodySwapSchema.nullable().catch(null),
    doorDecision: DoorDecisionSchema.nullable().catch(null),
    switchWeapon: z.coerce.number().finite()
        .transform((v) => Math.max(1, Math.min(9, Math.floor(v))))
        .nullable()
        .catch(null),
});

export const ClientInputMessageSchema = z.object({
    type: z.literal(MSG.INPUT),
    seq: z.coerce.number().finite().catch(0),
    input: InputPayloadSchema.catch(emptyInput()),
});

export const LoadMapRequestMessageSchema = z.object({
    type: z.literal(MSG.LOAD_MAP_REQUEST),
    mapName: z.string().refine((name) => ALLOWED_MAPS.has(name)),
});

export const MapLoadCompleteMessageSchema = z.object({
    type: z.literal(MSG.MAP_LOAD_COMPLETE),
});

export const WelcomeMessageSchema = z.object({
    type: z.literal(MSG.WELCOME),
    sessionId: z.string(),
    role: z.enum([ROLE.PLAYER, ROLE.SPECTATOR]),
    controlledId: z.string().nullable(),
    followTargetId: z.string().nullable(),
    mapName: z.string(),
    tickRateHz: z.coerce.number().finite().positive().catch(35),
    serverTime: z.coerce.number().finite().catch(0),
});

export const RoleChangeMessageSchema = z.object({
    type: z.literal(MSG.ROLE_CHANGE),
    role: z.enum([ROLE.PLAYER, ROLE.SPECTATOR]),
    controlledId: z.string().nullable(),
    followTargetId: z.string().nullable(),
});

export const MapLoadMessageSchema = z.object({
    type: z.literal(MSG.MAP_LOAD),
    mapName: z.string(),
    mapData: z.any(),
});

const IdDeltaBlockSchema = z.object({
    spawn: z.array(z.record(z.string(), z.any())).catch([]),
    update: z.array(z.record(z.string(), z.any())).catch([]),
    despawn: z.array(z.any()).catch([]),
}).partial();

export const SnapshotMessageSchema = z.object({
    type: z.literal(MSG.SNAPSHOT),
    tick: z.coerce.number().finite().optional(),
    serverTime: z.coerce.number().finite().optional(),
    role: z.enum([ROLE.PLAYER, ROLE.SPECTATOR]).optional(),
    controlledId: z.string().nullable().optional(),
    followTargetId: z.string().nullable().optional(),
    actors: IdDeltaBlockSchema.optional(),
    player: z.record(z.string(), z.any()).optional(),
    things: IdDeltaBlockSchema.optional(),
    projectiles: IdDeltaBlockSchema.optional(),
    /** Door rows: `sessionId` = operator session when a player possesses the door body. */
    doors: z.array(z.record(z.string(), z.any())).optional(),
    lifts: z.array(z.record(z.string(), z.any())).optional(),
    crushers: z.array(z.record(z.string(), z.any())).optional(),
    rendererEvents: z.array(z.any()).optional(),
    soundEvents: z.array(z.any()).optional(),
});

export const NoticeMessageSchema = z.object({
    type: z.literal(MSG.NOTICE),
    code: z.string().optional(),
    message: z.string().optional(),
    secondsUntilAction: z.coerce.number().finite().optional(),
});

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

/** Merge `partial` on top of defaults, clamping ranges and discarding junk. */
export function sanitizeInput(partial) {
    const parsed = InputPayloadSchema.safeParse(partial || {});
    return parsed.success ? parsed.data : emptyInput();
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
