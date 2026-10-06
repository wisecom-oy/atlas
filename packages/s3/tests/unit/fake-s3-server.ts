import { createServer, Agent, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { S3Client } from '@aws-sdk/client-s3';

export interface FakeReply {
  readonly status: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly delay_ms?: number;
}

export type FakeRoute = (req: IncomingMessage, request_number: number) => FakeReply;

export interface FakeS3 {
  readonly client: S3Client;
  readonly endpoint: string;
  readonly requests: () => number;
  readonly close: () => Promise<void>;
}

/** An S3 error body in the shape the SDK deserialises into a named service exception. */
export function s3_error(status: number, code: string): FakeReply {
  return {
    status,
    body: `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`,
    headers: { 'content-type': 'application/xml' },
  };
}

/** The backoff every retry in these tests sleeps, so retry timing is asserted exactly. */
export const RETRY_DELAY_MS = 40;

interface RetryToken {
  getRetryCount(): number;
  getRetryDelay(): number;
}

/**
 * The SDK's default strategy draws its backoff with full jitter, which can be zero. A fixed delay
 * keeps the retry loop real while making the reported delay exact.
 */
function fixed_delay_retries(max_attempts: number, delay_ms: number): never {
  const token = (count: number): RetryToken => ({
    getRetryCount: () => count,
    getRetryDelay: () => delay_ms,
  });
  return {
    mode: 'standard',
    acquireInitialRetryToken: async () => token(0),
    refreshRetryTokenForRetry: async (previous: RetryToken, info: { errorType: string }) => {
      const next = previous.getRetryCount() + 1;
      if (next >= max_attempts || info.errorType === 'CLIENT_ERROR') throw new Error('no retry');
      return token(next);
    },
    recordSuccess: () => undefined,
  } as never;
}

/**
 * A real HTTP listener on loopback with a real `S3Client` in front of it, so the SDK's retry loop,
 * connection pool and diagnostics channels all run for real. `max_sockets` sizes the pool, which
 * is how a test saturates it.
 */
export async function start_fake_s3(route: FakeRoute, max_sockets = 50): Promise<FakeS3> {
  let request_number = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const reply = route(req, ++request_number);
    req.resume();
    req.on('end', () => {
      setTimeout(() => {
        const body = reply.body ?? '';
        res.writeHead(reply.status, {
          'content-length': String(Buffer.byteLength(body)),
          etag: '"fake-etag"',
          ...reply.headers,
        });
        res.end(req.method === 'HEAD' ? undefined : body);
      }, reply.delay_ms ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${port}`;
  const agent = new Agent({ keepAlive: true, maxSockets: max_sockets });
  const client = new S3Client({
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    forcePathStyle: true,
    requestHandler: { httpAgent: agent },
    retryStrategy: fixed_delay_retries(3, RETRY_DELAY_MS),
  });

  return {
    client,
    endpoint,
    requests: () => request_number,
    close: async () => {
      client.destroy();
      agent.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
