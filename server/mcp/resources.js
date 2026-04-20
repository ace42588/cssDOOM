/**
 * Static resources exposed to MCP clients.
 *
 * The five guide documents under `docs/` are loaded once at module import
 * (they are bundled with the server image and don't change at runtime)
 * and registered as MCP resources under `cssdoom://docs/<slug>` URIs.
 *
 * Most agent runtimes auto-fetch resources whose `mimeType` is markdown;
 * those that don't will at least see them in `resources/list` and can
 * pull them on demand. The instructions string in `index.js` points
 * agents at `cssdoom://docs/agent-guide` so a curious client knows where
 * to start without having to enumerate.
 *
 * We also expose live resources backed by the same world reads the tools
 * use (`cssdoom://world/state`, `cssdoom://world/map`, `cssdoom://world/players`,
 * `cssdoom://role/current`). These are convenience reads for runtimes whose UI
 * prefers `resources/read` over `tools/call` for read-only data.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { getControlledFor } from '../../src/game/possession.js';
import { snapshotWorld, listPlayers } from './snapshot.js';
import { rolePromptFor } from './role.js';
import { getMapPayload } from '../world.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOCS_DIR = path.join(__dirname, 'docs');

const DOC_SLUGS = [
    {
        slug: 'agent-guide',
        title: 'Agent guide',
        description: "Start here. How to play cssDOOM as an MCP agent: connect, possess, move, fire, observe.",
    },
    {
        slug: 'coordinate-system',
        title: 'Coordinates and angles',
        description: 'DOOM coordinate conventions: x/y/z axes, angle (0 = +Y, counter-clockwise), distance ranges.',
    },
    {
        slug: 'recipes',
        title: 'Recipes',
        description: "Copy-pasteable patterns: turn-to-face, walk-N-units, hunt-closest-enemy, possess-and-attack, operate-door.",
    },
    {
        slug: 'gameplay-rules',
        title: 'Gameplay rules',
        description: 'What the engine enforces: tick rate, possession races, dead controllers, map transitions, what you cannot do.',
    },
    {
        slug: 'tool-index',
        title: 'Tool index',
        description: 'One-line summary of every tool, plus a routing table for "which body does each tool drive".',
    },
];

const docsCache = new Map();

function loadDoc(slug) {
    const cached = docsCache.get(slug);
    if (cached) return cached;
    const file = path.join(DOCS_DIR, `${slug}.md`);
    const text = readFileSync(file, 'utf8');
    docsCache.set(slug, text);
    return text;
}

function textResource(uri, mimeType, text) {
    return {
        contents: [{ uri, mimeType, text }],
    };
}

function jsonResource(uri, value) {
    return {
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }],
    };
}

export function registerStaticResources(server, ctx) {
    for (const { slug, title, description } of DOC_SLUGS) {
        const uri = `cssdoom://docs/${slug}`;
        server.registerResource(
            slug,
            uri,
            { title, description, mimeType: 'text/markdown' },
            async () => textResource(uri, 'text/markdown', loadDoc(slug)),
        );
    }

    // ── Live world resources (read-only, mirror the world.* tools) ─────

    server.registerResource(
        'world-state',
        'cssdoom://world/state',
        {
            title: 'World state (live)',
            description:
                'Authoritative world snapshot from this session\'s perspective: marine, enemies, doors, players. Same payload as the world-get-state tool.',
            mimeType: 'application/json',
        },
        async () => jsonResource('cssdoom://world/state', snapshotWorld(ctx.getSessionId())),
    );

    server.registerResource(
        'world-map',
        'cssdoom://world/map',
        {
            title: 'Current map (live)',
            description:
                'Current map name + full map JSON (vertices, lines, sectors, things). Use for offline path planning.',
            mimeType: 'application/json',
        },
        async () => {
            const { name, mapData } = getMapPayload();
            return jsonResource('cssdoom://world/map', { mapName: name, mapData });
        },
    );

    server.registerResource(
        'world-players',
        'cssdoom://world/players',
        {
            title: 'Players roster (live)',
            description:
                'Every connected session: role, controlled body, position, transport (ws/mcp), and MCP agent identity metadata. Identity is observational only unless auth is enabled.',
            mimeType: 'application/json',
        },
        async () => jsonResource('cssdoom://world/players', { players: listPlayers(ctx.getSessionId()) }),
    );

    server.registerResource(
        'role-current',
        'cssdoom://role/current',
        {
            title: 'Current role (live)',
            description:
                'Short guidance for the body this session currently controls (marine, enemy, door camera, or spectator). Same shape as the `role` object returned by actor-possess.',
            mimeType: 'application/json',
        },
        async () => jsonResource(
            'cssdoom://role/current',
            rolePromptFor(getControlledFor(ctx.getSessionId())),
        ),
    );
}

export const STATIC_DOC_URIS = DOC_SLUGS.map((d) => `cssdoom://docs/${d.slug}`);
