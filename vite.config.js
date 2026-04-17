import { defineConfig, loadEnv } from 'vite';

/** Browser posts here; Vite forwards to VITE_CAEP_RECEIVER_URL (server-side, no CORS). */
const CAEP_PROXY_PATH = '/__caep/ssf';
const SCIM_PROXY_PATH = '/__scim/v2';
const EVAL_PROXY_PATH = '/__sgnl/access';

function caepProxyRules(caepTarget) {
    if (!caepTarget?.trim()) return {};
    let u;
    try {
        u = new URL(caepTarget.trim());
    } catch {
        return {};
    }
    const pathAndQuery = u.pathname + u.search;
    return {
        [CAEP_PROXY_PATH]: {
            target: u.origin,
            changeOrigin: true,
            secure: u.protocol === 'https:',
            rewrite: () => pathAndQuery,
        },
    };
}

function scimProxyRules(scimTarget) {
    if (!scimTarget?.trim()) return {};
    let u;
    try {
        u = new URL(scimTarget.trim());
    } catch {
        return {};
    }

    const basePath = (u.pathname + u.search).replace(/\/+$/, '');
    return {
        [SCIM_PROXY_PATH]: {
            target: u.origin,
            changeOrigin: true,
            secure: u.protocol === 'https:',
            rewrite: (path) => {
                const suffix = path.replace(SCIM_PROXY_PATH, '');
                return `${basePath}${suffix || ''}`;
            },
        },
    };
}

function evalProxyRules(evalTarget) {
    if (!evalTarget?.trim()) return {};
    let u;
    try {
        u = new URL(evalTarget.trim());
    } catch {
        return {};
    }
    const pathAndQuery = u.pathname + u.search;
    return {
        [EVAL_PROXY_PATH]: {
            target: u.origin,
            changeOrigin: true,
            secure: u.protocol === 'https:',
            rewrite: () => pathAndQuery,
        },
    };
}

/**
 * Proxy `/ws` WebSocket traffic to the multiplayer server (default :8787).
 * Lets the browser speak to the server through Vite's origin in dev so
 * nothing special has to be wired on the client side.
 */
function gameServerProxyRules(target) {
    const url = target?.trim() || 'http://localhost:8787';
    return {
        '/ws': {
            target: url,
            ws: true,
            changeOrigin: true,
        },
    };
}

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');
    const proxy = {
        ...caepProxyRules(env.VITE_CAEP_RECEIVER_URL),
        ...scimProxyRules(env.VITE_SCIM_PUSH_URL),
        ...evalProxyRules(env.VITE_SGNL_EVAL_URL),
        ...gameServerProxyRules(env.VITE_GAME_SERVER_URL),
    };

    return {
        server: { proxy },
        preview: { proxy },
    };
});
