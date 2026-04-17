/**
 * SGNL gRPC map adapter — server-side.
 *
 * Exposes `startSgnlAdapter()` so the game server can bring the adapter up
 * alongside CAEP / SCIM / Access Evaluations on process start. Missing
 * configuration is non-fatal: when `SGNL_ADAPTER_VALID_TOKENS` is unset
 * the adapter warns and no-ops, mirroring the rest of the SGNL
 * integrations in `server/sgnl/*`.
 *
 * Env:
 *   SGNL_ADAPTER_VALID_TOKENS — comma-separated shared secrets SGNL will
 *     send in the gRPC `token` metadata. Required for the adapter to
 *     start; the rest of the fork works fine without it.
 *   SGNL_ADAPTER_PORT          — Listen port (default 8081).
 *   SGNL_ADAPTER_SOR_TYPE      — Optional. If set, GetPage enforces that
 *     `request.datasource.type` matches. See get-page.js.
 *   GRPC_MAX_MESSAGE_LENGTH    — Max gRPC send/receive bytes (default 256 MiB).
 */

import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleGetPage } from './get-page.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.join(__dirname, 'adapter.proto');

let server = null;

function parseTokens() {
    return (process.env.SGNL_ADAPTER_VALID_TOKENS || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
}

function makeGetPageHandler(validTokens) {
    return async function GetPage(call, callback) {
        try {
            const req = call.request;
            const meta = call.metadata.get('token');
            const reqToken = meta && meta.length ? meta[0] : '';
            const ok =
                validTokens.includes(reqToken) &&
                req?.entity?.id &&
                req?.datasource?.id;
            if (!ok) {
                return callback(null, {
                    error: { message: 'Invalid GetPageRequest', code: 1 },
                });
            }
            const result = await handleGetPage(req);
            if (result.error) return callback(null, { error: result.error });
            callback(null, { success: result.success });
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[sgnl-adapter] GetPage error:', err);
            callback(null, { error: { message: err.message, code: 10 } });
        }
    };
}

/**
 * Start the SGNL gRPC adapter. Resolves with the bound `grpc.Server`
 * instance, or `null` when the adapter is disabled because no tokens are
 * configured. Rejects only on a real `bindAsync` failure.
 */
export async function startSgnlAdapter() {
    if (server) return server;

    const validTokens = parseTokens();
    if (validTokens.length === 0) {
        // eslint-disable-next-line no-console
        console.warn('[sgnl-adapter] SGNL_ADAPTER_VALID_TOKENS not set — adapter disabled');
        return null;
    }

    const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(packageDefinition).sgnl.adapter.v1;

    const maxMsg =
        Number(process.env.GRPC_MAX_MESSAGE_LENGTH) ||
        Number(process.env.GRPC_MAX_MESSAGE_SIZE) ||
        256 * 1024 * 1024;

    server = new grpc.Server({
        'grpc.max_receive_message_length': maxMsg,
        'grpc.max_send_message_length': maxMsg,
    });
    server.addService(proto.Adapter.service, { GetPage: makeGetPageHandler(validTokens) });

    const port = Number(process.env.SGNL_ADAPTER_PORT) || 8081;
    return new Promise((resolve, reject) => {
        server.bindAsync(
            `0.0.0.0:${port}`,
            grpc.ServerCredentials.createInsecure(),
            (err) => {
                if (err) {
                    // eslint-disable-next-line no-console
                    console.error('[sgnl-adapter] bindAsync failed:', err);
                    server = null;
                    return reject(err);
                }
                // eslint-disable-next-line no-console
                console.log(
                    `[sgnl-adapter] gRPC listening on :${port} (max message ${maxMsg} bytes)`,
                );
                resolve(server);
            },
        );
    });
}

/** Gracefully stop the adapter (test / shutdown hook). */
export function stopSgnlAdapter() {
    if (!server) return;
    server.forceShutdown();
    server = null;
}
