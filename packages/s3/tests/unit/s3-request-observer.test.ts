import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCopyCommand,
} from '@aws-sdk/client-s3';
import type { StorageRequestEvent } from '@wisecom/atlas-types';
import { run_with_log_scope, SILENT_LOG_SINK } from '@wisecom/atlas-core/utils/log-context';
import { observe_storage_requests } from '@/adapters/s3-request-observer';
import {
  RETRY_DELAY_MS,
  s3_error,
  start_fake_s3,
  type FakeRoute,
  type FakeS3,
} from './fake-s3-server';

const BUCKET = 'atlas-00000000-0000-0000-0000-000000000000';
const OWNER = 'aaaaaaaa-1111-2222-3333-444444444444';
const OK: FakeRoute = () => ({ status: 200, body: 'hello' });

let fake: FakeS3 | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

/** Starts a fake backend with an observer on its client and collects what it reports. */
async function observed(
  route: FakeRoute,
): Promise<{ fake: FakeS3; events: StorageRequestEvent[] }> {
  fake = await start_fake_s3(route);
  const events: StorageRequestEvent[] = [];
  observe_storage_requests(fake.client, (event) => events.push(event), 'primary');
  return { fake, events };
}

describe('observe_storage_requests', () => {
  it('reports an upload with its body size, layout class and outcome', async () => {
    const { fake, events } = await observed(OK);

    await fake.client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: `onedrive/data/${OWNER}/abc`,
        Body: Buffer.alloc(4096),
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      command: 'PutObject',
      workload: 'onedrive',
      keyClass: 'data',
      target: 'primary',
      attempts: 1,
      retryDelayMs: 0,
      bytes: 4096,
      statusCode: 200,
    });
    expect(events[0]?.errorType).toBeUndefined();
  });

  it('reports a read with the response ContentLength', async () => {
    const { fake, events } = await observed(OK);

    const response = await fake.client.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: `manifests/${OWNER}/snap.json` }),
    );
    await response.Body?.transformToString();

    expect(events[0]).toMatchObject({
      command: 'GetObject',
      workload: 'outlook',
      keyClass: 'manifests',
      bytes: 5,
    });
  });

  it('reports no bytes for a HEAD, whose ContentLength is the stored size, not a transfer', async () => {
    const { fake, events } = await observed(OK);

    const head = await fake.client.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: `data/${OWNER}/abc` }),
    );

    expect(head.ContentLength).toBe(5);
    expect(events[0]).toMatchObject({ command: 'HeadObject', statusCode: 200 });
    expect(events[0]).not.toHaveProperty('bytes');
  });

  it('reports the copied range length for a server-side part copy', async () => {
    const { fake, events } = await observed(() => ({
      status: 200,
      body: '<CopyPartResult><ETag>"e"</ETag></CopyPartResult>',
    }));

    await fake.client.send(
      new UploadPartCopyCommand({
        Bucket: BUCKET,
        Key: `onedrive/data/${OWNER}/big`,
        UploadId: 'u',
        PartNumber: 1,
        CopySource: `${BUCKET}/onedrive/staging/${OWNER}/x`,
        CopySourceRange: 'bytes=0-1023',
      }),
    );

    expect(events[0]?.bytes).toBe(1024);
  });

  it('counts SDK retries and the backoff slept between them', async () => {
    const { fake, events } = await observed((_req, n) =>
      n === 1 ? s3_error(503, 'SlowDown') : OK(_req, n),
    );

    await fake.client.send(new HeadBucketCommand({ Bucket: BUCKET }));

    expect(fake.requests()).toBe(2);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.attempts).toBe(2);
    expect(event?.retryDelayMs).toBe(RETRY_DELAY_MS);
    expect(event?.workload).toBe('bucket');
    // Every part of the split is contained in the whole.
    const parts = (event?.socketWaitMs ?? 0) + (event?.networkMs ?? 0) + (event?.retryDelayMs ?? 0);
    expect(event?.durationMs).toBeGreaterThanOrEqual(parts);
  });

  it('reports a failure by its S3 error code and still rethrows the original error', async () => {
    const { fake, events } = await observed(() => s3_error(404, 'NoSuchKey'));

    const failure = fake.client.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: `data/${OWNER}/gone` }),
    );

    await expect(failure).rejects.toMatchObject({ name: 'NoSuchKey' });
    expect(events[0]).toMatchObject({
      command: 'GetObject',
      errorType: 'NoSuchKey',
      statusCode: 404,
    });
  });

  it('never puts the object key, owner id or bucket name in an event', async () => {
    const { fake, events } = await observed(OK);

    await fake.client.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: `data/${OWNER}/abc`, Body: 'x' }),
    );

    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain(OWNER);
    expect(serialised).not.toContain(BUCKET);
    expect(serialised).not.toContain('127.0.0.1');
  });

  it('names the SDK method in progress, and leaves it out otherwise', async () => {
    const { fake, events } = await observed(OK);
    const head = (): Promise<unknown> =>
      fake.client.send(new HeadBucketCommand({ Bucket: BUCKET }));

    await run_with_log_scope({ sink: SILENT_LOG_SINK, fields: { operation: 'backup' } }, head);
    await head();

    expect(events[0]?.operation).toBe('backup');
    expect(events[1]).not.toHaveProperty('operation');
  });

  it('runs the observer in the caller async context', async () => {
    const host_context = new AsyncLocalStorage<string>();
    fake = await start_fake_s3(OK);
    const seen: (string | undefined)[] = [];
    observe_storage_requests(fake.client, () => seen.push(host_context.getStore()), 'primary');

    await host_context.run('attempt-7', () =>
      fake!.client.send(new HeadBucketCommand({ Bucket: BUCKET })),
    );

    expect(seen).toEqual(['attempt-7']);
  });

  it.each([
    [
      'throws',
      (): void => {
        throw new Error('host bug');
      },
    ],
    ['rejects', (async (): Promise<void> => Promise.reject(new Error('host bug'))) as () => void],
  ])('keeps the request outcome when the observer %s', async (_label, observer) => {
    fake = await start_fake_s3(OK);
    observe_storage_requests(fake.client, observer, 'primary');

    await expect(
      fake.client.send(new HeadBucketCommand({ Bucket: BUCKET })),
    ).resolves.toBeDefined();
  });
});
