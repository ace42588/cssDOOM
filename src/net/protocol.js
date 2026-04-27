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
    /** Joiner reviews an MCP agent's defense before displacing them or staying spectator. */
    JOIN_CHALLENGE: 'joinChallenge',
    /** Client → server: resolve a pending join challenge. */
    JOIN_CHALLENGE_DECISION: 'joinChallengeDecision',
};

const ALLOWED_MAPS = new Set([
    'E1M1', 'E1M2', 'E1M3', 'E1M4', 'E1M5', 'E1M6', 'E1M7', 'E1M8', 'E1M9',
]);

export const ROLE = {
    PLAYER: 'player',
    SPECTATOR: 'spectator',
};

const DoorDecisionSchema = z.object({
    sectorIndex: z.coerce.number().finite(),
    requestId: z.coerce.number().finite(),
    decision: z.enum(['open', 'ignore']).catch('ignore'),
});

const BodySwapSchema = z.object({
    targetId: z.any().nullable(),
});

const InputPayloadSchema = z.object({
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

/**
 * Uniform actor record. Every actor (marine, enemy, possessed monster, AI
 * marine) ships with the same shape; optional sub-blocks carry loadout /
 * inventory / AI state only when the actor has them. Fields are optional so
 * a delta can update any subset without repeating stable fields.
 */
const ActorRecordSchema = z.object({
    id: z.coerce.number().finite(),
    type: z.coerce.number().finite().optional(),
    x: z.coerce.number().finite().optional(),
    y: z.coerce.number().finite().optional(),
    z: z.coerce.number().finite().nullable().optional(),
    floorHeight: z.coerce.number().finite().optional(),
    angle: z.coerce.number().finite().nullable().optional(),
    facing: z.coerce.number().finite().nullable().optional(),
    hp: z.coerce.number().finite().nullable().optional(),
    maxHp: z.coerce.number().finite().nullable().optional(),
    collected: z.boolean().optional(),
    aiState: z.string().nullable().optional(),
    armor: z.coerce.number().finite().nullable().optional(),
    armorType: z.coerce.number().finite().nullable().optional(),
    ammo: z.record(z.string(), z.coerce.number().finite()).nullable().optional(),
    maxAmmo: z.record(z.string(), z.coerce.number().finite()).nullable().optional(),
    ownedWeapons: z.array(z.coerce.number().finite()).nullable().optional(),
    currentWeapon: z.coerce.number().finite().nullable().optional(),
    collectedKeys: z.array(z.string()).nullable().optional(),
    powerups: z.record(z.string(), z.any()).nullable().optional(),
    hasBackpack: z.boolean().optional(),
    isDead: z.boolean().optional(),
    isAiDead: z.boolean().optional(),
    isFiring: z.boolean().optional(),
    __sessionId: z.string().nullable().optional(),
}).passthrough();

const ActorDeltaBlockSchema = z.object({
    spawn: z.array(ActorRecordSchema).catch([]),
    update: z.array(ActorRecordSchema).catch([]),
    despawn: z.array(z.coerce.number().finite()).catch([]),
}).partial();

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
    actors: ActorDeltaBlockSchema.optional(),
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

const JoinChallengeDefenseSchema = z.object({
    justification: z.string(),
    intendedAction: z.string().optional(),
});

const JoinChallengeDefenseStateSchema = z.enum([
    'accepted',
    'declined',
    'timeout',
    'unsupported',
    'error',
]);

export const JoinChallengeMessageSchema = z.object({
    type: z.literal(MSG.JOIN_CHALLENGE),
    challengeId: z.string(),
    targetEntityId: z.string(),
    targetAgent: z.object({
        agentId: z.string(),
        agentName: z.string(),
        runtime: z.string().nullable(),
    }),
    defense: JoinChallengeDefenseSchema.nullable(),
    defenseState: JoinChallengeDefenseStateSchema,
    expiresAt: z.coerce.number().finite(),
    /** Server already applied displacement (joiner is now player). */
    autoResolved: z.boolean().optional(),
});

export const JoinChallengeDecisionMessageSchema = z.object({
    type: z.literal(MSG.JOIN_CHALLENGE_DECISION),
    challengeId: z.string(),
    decision: z.enum(['displace', 'spectate']),
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
