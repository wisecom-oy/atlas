import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import type { S3TransportSettings } from '@wisecom/atlas-core';
import { StorageUnavailableError, type StorageRequestEvent } from '@wisecom/atlas-types';
import { create_s3_client } from '@/adapters/s3-client.factory';
import { observe_storage_requests } from '@/adapters/s3-request-observer';

// Issue #924: a backend that accepts the connection and never answers held a run forever. Real
// loopback sockets only; nothing leaves the machine.

const TRANSPORT: S3TransportSettings = {
  connection_timeout_ms: 1_000,
  idle_timeout_ms: 1_000,
  max_attempts: 2,
};

let client: S3Client | undefined;
let server: Server | undefined;
const sockets = new Set<Socket>();

afterEach(async () => {
  client?.destroy();
  client = undefined;
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** A TCP listener that accepts every connection and never writes a byte back. */
async function start_silent_server(): Promise<string> {
  server = createServer((socket) => {
    sockets.add(socket);
    socket.resume();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A loopback port that was just released, so a connect to it is refused. */
async function closed_port_endpoint(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

function client_for(endpoint: string): S3Client {
  client = create_s3_client({
    s3_endpoint: endpoint,
    s3_region: 'us-east-1',
    s3_access_key: '<redacted>',
    s3_secret_key: '<redacted>',
    s3_transport: TRANSPORT,
  });
  return client;
}

/** Sends one request and returns what it rejected with and how long that took. */
async function failed_request(s3: S3Client): Promise<{ error: unknown; elapsed_ms: number }> {
  const started = Date.now();
  const error = await s3.send(new HeadBucketCommand({ Bucket: 'atlas-test' })).then(
    () => undefined,
    (err: unknown) => err,
  );
  return { error, elapsed_ms: Date.now() - started };
}

describe('S3 client against a backend that never answers', () => {
  it('fails each attempt at the idle timeout as StorageUnavailableError', async () => {
    const { error, elapsed_ms } = await failed_request(client_for(await start_silent_server()));

    expect(error).toBeInstanceOf(StorageUnavailableError);
    const unavailable = error as StorageUnavailableError;
    expect(unavailable.code).toBe('ATLAS_STORAGE_UNAVAILABLE');
    expect(unavailable.attempts).toBe(2);
    expect((unavailable.cause as Error).name).toBe('TimeoutError');
    // Two attempts of one idle timeout each, plus at most 100 ms of backoff between them.
    expect(elapsed_ms).toBeGreaterThanOrEqual(1_900);
    expect(elapsed_ms).toBeLessThan(3_500);
  });

  it('lets the storage request observer see the SDK error, not the translation', async () => {
    const s3 = client_for(await start_silent_server());
    const events: StorageRequestEvent[] = [];
    observe_storage_requests(s3, (event) => events.push(event));

    await failed_request(s3);

    expect(events).toHaveLength(1);
    expect(events[0]?.errorType).toBe('TimeoutError');
    expect(events[0]?.attempts).toBe(2);
  });

  it('fails a refused connection as StorageUnavailableError without waiting', async () => {
    const { error, elapsed_ms } = await failed_request(client_for(await closed_port_endpoint()));

    expect(error).toBeInstanceOf(StorageUnavailableError);
    expect((error as StorageUnavailableError).cause).toMatchObject({ code: 'ECONNREFUSED' });
    expect(elapsed_ms).toBeLessThan(1_000);
  });
});
