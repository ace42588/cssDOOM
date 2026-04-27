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
 *   { type: 'joinChallengeDecision', challengeId, decision: 'displace' | 'spectate' }
 *      Sent by a WebSocket client after receiving `joinChallenge` with autoResolved false.
 *
 *   { type: 'loadMapRequest', mapName }
 *      Ask the server to switch the world to a specific map. Used by the
 *      menu/level picker. Inventory carries over so the player keeps the
 *      run going. Server replies by broadcasting a `mapLoad` (and fresh
 *      `roleChange` for every connection).
 *
 *   { type: 'mapLoadComplete' }
 *      Sent by the client once it has finished rebuilding its scene from
 *      a `mapLoad`. The server suppresses snapshots to a connection from
 *      the moment it sends `mapLoad` until this ack lands, then resets
 *      that connection's delta baseline so the next tick carries a full
 *      "spawn everything" snapshot the client can apply cleanly. Without
 *      this ack the server would commit baseline updates for snapshots
 *      the client dropped during its rebuild window, leaving the local
 *      view stuck at default (zeroed) values.
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
 *       // Per-viewer identity — included only when changed for this conn.
 *       role?, controlledId?, followTargetId?,
 *
 *       // Player partial — only fields whose value changed since the last
 *       // snapshot sent to this connection. Omitted entirely when nothing
 *       // about the marine changed this tick. Container fields (ammo,
 *       // ownedWeapons, collectedKeys, powerups) are sent whole or not
 *       // at all.
 *       player?: { ...onlyChangedFields },
 *
 *       // Things — per-id spawn/update/despawn. Things have stable numeric
 *       // ids (thingIndex). `spawn` is a full serialized record used to
 *       // materialize the entity; `update` carries only changed fields;
 *       // `despawn` is just the id.
 *       things: {
 *           spawn:   [{ id, type, x, y, z, floorHeight, facing, viewAngle,
 *                       hp, maxHp, collected, aiState, __sessionId (controller session, derived server-side) }],
 *           update:  [{ id, ...changedFields }],
 *           despawn: [id, id, ...]
 *       },
 *
 *       // Projectiles — same spawn/update/despawn shape, keyed by id.
 *       // Per-projectile DOM lifecycle (creation/removal of the CSS-driven
 *       // element) continues to flow through `rendererEvents` via
 *       // `createProjectile` / `removeProjectile`; this block only tracks
 *       // `state.projectiles` membership + position.
 *       projectiles: {
 *           spawn:   [{ id, x, y, z }],
 *           update:  [{ id, ...changedFields }],
 *           despawn: [id, id, ...]
 *       },
 *
 *       // Static per-map entities — membership is fixed across a map, so
 *       // only `update` entries with changed fields are emitted.
 *       //
 *       // Mutable fields that flow over the wire:
 *       //   doors:    open, passable, sessionId, viewAngle,
 *       //             pendingRequests
 *       //   lifts:    currentHeight, targetHeight, moving
 *       //   crushers: active, direction, currentHeight, damageTimer
 *       //
 *       // Immutable per-map fields (lift.tag/lowerHeight/upperHeight/
 *       // oneWay, crusher.topHeight/crushHeight, door.keyRequired) are
 *       // NOT in the snapshot — they live in `mapData` shipped with
 *       // `mapLoad` and are populated on the client by
 *       // `initDoors/initLifts/initCrushers`.
 *       doors:    [{ sectorIndex, ...changedFields }],
 *       lifts:    [{ sectorIndex, ...changedFields }],
 *       crushers: [{ sectorIndex, ...changedFields }],
 *
 *       rendererEvents: Array<{ fn: string, args: any[], forSessionId?: string }>,
 *       soundEvents:   Array<string | { sound: string, forSessionId?: string }>,
 *   }
 *
 *   { type: 'notice', code: 'idle-warning' | 'idle-drop',
 *       message: string, secondsUntilAction?: number }
 *
 *   { type: 'joinChallenge', challengeId, targetEntityId, targetAgent: { agentId, agentName, runtime },
 *       defense: { justification, intendedAction? } | null,
 *       defenseState: 'accepted' | 'declined' | 'timeout' | 'unsupported' | 'error',
 *       expiresAt, autoResolved?: boolean }
 *
 * Snapshots are deltas computed per-connection against a server-held
 * `baseline` of the last values sent to that connection. A fresh connection
 * starts with an empty baseline, so its first tick naturally carries the
 * whole world. `mapLoad` resets every connection's baseline, and the first
 * post-load tick is again a full "spawn everything" delta. WebSocket is
 * ordered and reliable, so baselines are committed synchronously at send
 * time — no ack / resync protocol is needed.
 *
 *   { type: 'bye', reason }
 */

export {
    ClientInputMessageSchema,
    JoinChallengeDecisionMessageSchema,
    LoadMapRequestMessageSchema,
    MSG,
    ROLE,
    emptyInput,
    sanitizeInput,
} from '../src/net/protocol.js';
