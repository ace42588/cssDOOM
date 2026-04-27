/**
 * Bootstrapping prompts for MCP clients.
 *
 * These are templates an agent runtime can fetch via `prompts/get` to
 * seed a play session with a focused goal + the right reference docs
 * pre-loaded as resource references. They are NOT system prompts in the
 * "always-on rules" sense — they're starting points the user picks
 * ("play the game", "hunt another player", "operate a door"). The
 * controlled body is whichever actor the server hands you on connect —
 * marine or possessed monster — and each prompt works against that
 * capability-driven body, not a hardcoded role.
 */

import { z } from 'zod';

function userText(text) {
    return { role: 'user', content: { type: 'text', text } };
}

const GUIDE_REF = `Reference docs (read these first):

- cssdoom://docs/agent-guide       — overall how-to-play
- cssdoom://docs/coordinate-system — angle, axis, distance conventions
- cssdoom://docs/recipes           — copy-pasteable patterns
- cssdoom://docs/gameplay-rules    — what the engine enforces
- cssdoom://docs/tool-index        — full tool list
- cssdoom://role/current           — current body role + behavior hints

Session hygiene: echo Mcp-Session-Id on every HTTP request after initialize; every tool response includes a top-level sessionId so you can detect accidental re-inits. MCP sessions are not idle-disconnected (only WS clients are).`;

export function registerPrompts(server, _ctx) {
    void _ctx;

    server.registerPrompt(
        'play-the-game',
        {
            title: 'Play the game',
            description: 'Bootstrap: act as a player, explore the map, and engage enemies you find.',
            argsSchema: {
                style: z
                    .enum(['cautious', 'aggressive', 'completionist'])
                    .optional()
                    .describe('Playstyle hint — defaults to "cautious".'),
            },
        },
        ({ style }) => {
            const s = style || 'cautious';
            const guidance = {
                cautious: 'Prefer cover and distance. Don\'t engage unless your HP is high or the enemy is alone.',
                aggressive: 'Close the distance and prioritize damage. Switch to the strongest weapon you have ammo for.',
                completionist: 'Explore every corridor before fighting. Pick up keys, then return to engage.',
            }[s];
            return {
                description: `Play the game with a ${s} style.`,
                messages: [
                    userText(`You are playing cssDOOM as an AI peer. Your role: ${s}. ${guidance}`),
                    userText(GUIDE_REF),
                    userText(
                        [
                            'Loop:',
                            '  1. world-get-state — observe `self.controlledActor` and the `actors` / `doors` / `players` lists',
                            '  2. plan one action',
                            '  3. invoke actor-* (driving your body) / actor-list / actor-get-state / doors-* and actor-possess when swapping bodies',
                            '  4. wait ~100ms',
                            '  5. world-get-state — observe again, repeat',
                            '',
                            'Start now by calling world-get-state.',
                        ].join('\n'),
                    ),
                ],
            };
        },
    );

    server.registerPrompt(
        'hunt-a-peer',
        {
            title: 'Hunt another player',
            description: 'Bootstrap: find another connected player (human or agent) and attack them.',
            argsSchema: {
                preferredBody: z
                    .enum(['marine', 'enemy', 'either'])
                    .optional()
                    .describe('Preferred body to hunt with. Defaults to whatever the server gives you.'),
            },
        },
        ({ preferredBody }) => {
            const pref = preferredBody || 'either';
            const switchHint = pref === 'marine'
                ? 'If you were given an enemy on connect, call actor-possess ({ targetId: "marine" }) to try to take the marine.'
                : pref === 'enemy'
                    ? 'If you were given the marine, call actor-list ({ kind: "enemy", alive: true }) then actor-possess ({ targetId: "actor:N" | "thing:N" }) to take a strong enemy (e.g. baron) instead.'
                    : 'Use whichever body the server gave you.';
            return {
                description: `Hunt a peer with body=${pref}.`,
                messages: [
                    userText('You are an AI peer in cssDOOM multiplayer. Goal: locate another connected player and attack them.'),
                    userText(GUIDE_REF),
                    userText(
                        [
                            'Procedure:',
                            '  1. world-get-state — confirm what body you control (`self.controlledActor`).',
                            `  2. ${switchHint}`,
                            '  3. players-peers ({ onlyControlling: true }) — pick a target.',
                            '  4. Compute the angle to the target (see coordinate-system.md).',
                            '  5. actor-turn-by to face them, then actor-set-move forward to close.',
                            '  6. actor-fire (with durationMs) when in range.',
                            '  7. Loop: poll world-get-state, retarget if your peer moves.',
                            '',
                            'Start by calling world-get-state.',
                        ].join('\n'),
                    ),
                ],
            };
        },
    );

    server.registerPrompt(
        'operate-a-door',
        {
            title: 'Operate a door',
            description: 'Bootstrap: take over a door security camera and adjudicate access requests.',
            argsSchema: {},
        },
        () => ({
            description: 'Become a door operator and approve/deny access requests.',
            messages: [
                userText('You are an AI peer in cssDOOM. Goal: become a door operator and gate other players\' access through that door.'),
                userText(GUIDE_REF),
                userText(
                    [
                        'Procedure:',
                        '  1. doors-list — find a door with pendingRequests, or one likely to attract traffic (key-locked, near spawn).',
                        '  2. actor-possess ({ targetId: "door:N" }) — take operator status (N = sectorIndex from doors-list).',
                        '  3. world-get-state to confirm self.controlledKind === "door".',
                        '  4. Loop: doors-get-state ({ sectorIndex }) — when pendingRequests is non-empty, decide:',
                        '     - approve known-friendly identifiers via doors-approve-request',
                        '     - deny unknown / hostile via doors-deny-request',
                        '  5. If you lose operator status (someone else possesses), recover by re-possessing.',
                        '',
                        'Start by calling doors-list.',
                    ].join('\n'),
                ),
            ],
        }),
    );
}
