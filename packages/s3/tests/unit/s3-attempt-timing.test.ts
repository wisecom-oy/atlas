import { afterEach, describe, expect, it } from 'vitest';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import type { StorageRequestEvent } from '@wisecom/atlas-types';
import { observe_storage_requests } from '@/adapters/s3-request-observer';
import { supports_attempt_timing } from '@/adapters/s3-attempt-timing';
import { start_fake_s3, type FakeS3 } from './fake-s3-server';

const BACKEND_MS = 150;

let fake: FakeS3 | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

/** Sends HEAD requests to a backend with a fixed response time through a pool of `sockets`. */
async function head_requests(
  count: number,
  sockets: number,
  sequential = false,
): Promise<StorageRequestEvent[]> {
  fake = await start_fake_s3(() => ({ status: 200, delay_ms: BACKEND_MS }), sockets);
  const events: StorageRequestEvent[] = [];
  observe_storage_requests(fake.client, (event) => events.push(event), 'primary');
  const head = (i: number): Promise<unknown> =>
    fake!.client.send(new HeadObjectCommand({ Bucket: 'b', Key: `data/owner/${i}` }));
  if (sequential) {
    for (let i = 0; i < count; i++) await head(i);
  } else {
    await Promise.all(Array.from({ length: count }, (_, i) => head(i)));
  }
  return events;
}

describe.skipIf(!supports_attempt_timing())('socket wait and network split', () => {
  it('keeps networkMs at the backend time while socketWaitMs absorbs pool queueing', async () => {
    // Six requests through two sockets: three waves, each waiting for the one before.
    const events = await head_requests(6, 2);

    for (const event of events) {
      expect(event.networkMs).toBeGreaterThanOrEqual(BACKEND_MS - 5);
      // Queueing adds up to two backend times to the later requests; none of it may land here.
      expect(event.networkMs).toBeLessThan(BACKEND_MS * 2);
    }
    const waits = events.map((event) => event.socketWaitMs ?? 0).sort((a, b) => a - b);
    expect(waits[0]).toBeLessThan(BACKEND_MS / 2);
    expect(waits[5]).toBeGreaterThanOrEqual(BACKEND_MS * 2 - 20);
  });

  it('reports a new connection first and a reused keep-alive connection after it', async () => {
    const events = await head_requests(2, 1, true);

    expect(events.map((event) => event.connectionReused)).toEqual([false, true]);
  });
});

describe('supports_attempt_timing', () => {
  it.each([
    ['20.18.0', false],
    ['22.11.0', false],
    ['22.12.0', true],
    ['22.22.2', true],
    ['23.1.0', false],
    ['23.2.0', true],
    ['24.11.1', true],
  ])('Node %s → %s', (version, expected) => {
    expect(supports_attempt_timing(version)).toBe(expected);
  });
});
