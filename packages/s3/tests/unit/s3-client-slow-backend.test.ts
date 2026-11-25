import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GetObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { StorageUnavailableError } from '@wisecom/atlas-types';
import { create_s3_client } from '@/adapters/s3-client.factory';

// Issue #924: the idle timeout must not cut off a slow transfer that keeps moving bytes, and an
// early burst of retryable errors must not leave later requests without retries.

let client: S3Client | undefined;
let server: Server | undefined;

afterEach(async () => {
  client?.destroy();
  client = undefined;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function start_backend(
  handle: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<S3Client> {
  server = createServer(handle);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  client = create_s3_client({
    s3_endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    s3_region: 'us-east-1',
    s3_access_key: '<redacted>',
    s3_secret_key: '<redacted>',
    s3_transport: { connection_timeout_ms: 1_000, idle_timeout_ms: 1_000, max_attempts: 2 },
  });
  return client;
}

/** Sends `chunks` chunks of the body, one every `interval_ms`. */
function drip_body(res: ServerResponse, chunks: number, interval_ms: number): void {
  res.writeHead(200, { 'content-length': String(chunks), 'content-type': 'text/plain' });
  let sent = 0;
  const timer = setInterval(() => {
    res.write('x');
    if (++sent === chunks) {
      clearInterval(timer);
      res.end();
    }
  }, interval_ms);
  res.on('close', () => clearInterval(timer));
}

describe('S3 client idle timeout', () => {
  it('lets a download that takes three idle timeouts finish while bytes keep arriving', async () => {
    const s3 = await start_backend((_req, res) => drip_body(res, 10, 300));
    const started = Date.now();

    const response = await s3.send(new GetObjectCommand({ Bucket: 'atlas-test', Key: 'slow' }));
    const body = await response.Body!.transformToString();

    expect(body).toBe('x'.repeat(10));
    expect(Date.now() - started).toBeGreaterThan(2_500);
  });
});

describe('S3 client retries', () => {
  it('still retries a later request after a burst of exhausted retryable failures', async () => {
    let later_attempts = 0;
    const s3 = await start_backend((req, res) => {
      const failing = req.url?.includes('burst') || ++later_attempts === 1;
      res.writeHead(failing ? 503 : 200, { 'content-length': '0' }).end();
    });
    // 60 retries at a cost of 10 each exceed the SDK's 500-token bucket for the whole client.
    const burst = Array.from({ length: 60 }, (_, index) =>
      s3
        .send(new HeadObjectCommand({ Bucket: 'atlas-test', Key: `burst-${index}` }))
        .catch((err: unknown) => err),
    );
    const burst_errors = await Promise.all(burst);

    const later = await s3.send(new HeadObjectCommand({ Bucket: 'atlas-test', Key: 'later' }));

    expect(later.$metadata.attempts).toBe(2);
    expect(later_attempts).toBe(2);
    for (const err of burst_errors) {
      // An HTTP answer is not "unavailable": it passes through with its status for callers.
      expect(err).not.toBeInstanceOf(StorageUnavailableError);
      expect(err).toMatchObject({ $metadata: { httpStatusCode: 503, attempts: 2 } });
    }
  });
});
