import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { handleGetPage } from './get-page.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..', '..');
dotenv.config({ path: path.join(repoRoot, '.env') });

const PROTO_PATH = path.join(__dirname, 'adapter.proto');

const validTokens = process.env.VALID_TOKENS?.split(',').map((t) => t.trim()).filter(Boolean) || [];
if (validTokens.length === 0) {
  console.error(
    'VALID_TOKENS is not set (export it or add VALID_TOKENS=... to .env at the repo root)',
  );
  process.exit(1);
}
console.log('validTokens', validTokens);

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

function isValidRequest(request, token) {
  return (
    validTokens.includes(token) &&
    request?.entity?.id &&
    request?.datasource?.id
  );
}

async function GetPage(call, callback) {
  try {
    const req = call.request;
    const meta = call.metadata.get('token');
    const reqToken = meta && meta.length ? meta[0] : '';
    if (!isValidRequest(req, reqToken)) {
      return callback(null, {
        error: {
          message: 'Invalid GetPageRequest',
          code: 1,
        },
      });
    }

    const result = await handleGetPage(req);
    if (result.error) {
      return callback(null, { error: result.error });
    }

    callback(null, { success: result.success });
  } catch (err) {
    console.error('Error in GetPage:', err);
    callback(null, {
      error: {
        message: err.message,
        code: 10,
      },
    });
  }
}

const server = new grpc.Server({
  'grpc.max_receive_message_length': maxMsg,
  'grpc.max_send_message_length': maxMsg,
});
server.addService(proto.Adapter.service, { GetPage });

const port = process.env.PORT || '8081';
server.bindAsync(
  `0.0.0.0:${port}`,
  grpc.ServerCredentials.createInsecure(),
  (err) => {
    if (err) {
      console.error('bindAsync failed:', err);
      process.exit(1);
    }
    console.log(
      `gRPC adapter listening on 0.0.0.0:${port} (max message ${maxMsg} bytes)`,
    );
  },
);
