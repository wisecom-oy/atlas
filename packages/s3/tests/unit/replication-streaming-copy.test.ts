import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import { replicate_drive_snapshot_objects } from '@wisecom/atlas-core/services/replication/drive-snapshot-replicator';
import { REPLICATION_PART_BYTES } from '@wisecom/atlas-core/services/replication/replication-object-copy';
import { BucketCache } from '@/adapters/bucket-cache';
import { S3ObjectStorage } from '@/adapters/s3-object-storage.adapter';
import { start_fake_s3, s3_error, type FakeReply, type FakeS3 } from './fake-s3-server';

/**
 * Issue #627: drive replication downloaded every object whole, wrote it with a single PutObject
 * (refused by S3 above 5 GiB), then downloaded it again only to count its bytes. This runs the real
 * replicator and the real S3 adapter against two loopback S3 endpoints, so the requests counted are
 * the ones the SDK actually sent.
 */

const BUCKET = 'atlas-tenant-1';
const DATA_KEY = 'onedrive/data/owner-1/hash-1';
const MANIFEST_KEY = 'onedrive/manifests/owner-1/snapshot-1.json';

interface FakeBucket {
  readonly fake: FakeS3;
  readonly objects: Map<string, Buffer>;
  /** Every request as `METHOD key`, with `?part` or `?uploads` marking multipart calls. */
  readonly log: string[];
}

function xml(body: string): FakeReply {
  return { status: 200, body, headers: { 'content-type': 'application/xml' } };
}

/** A single-bucket S3 that keeps what it is sent, enough for PutObject and multipart uploads. */
async function start_fake_bucket(seed: Record<string, Buffer> = {}): Promise<FakeBucket> {
  const objects = new Map(Object.entries(seed));
  const parts = new Map<number, Buffer>();
  const log: string[] = [];

  const on_body = (req: IncomingMessage, store: (body: Buffer) => void): void => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => store(Buffer.concat(chunks)));
  };

  const fake = await start_fake_s3((req) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const key = decodeURIComponent(url.pathname.slice(`/${BUCKET}/`.length));
    const part = url.searchParams.get('partNumber');
    const upload_id = url.searchParams.get('uploadId');
    const kind = part ? '?part' : url.searchParams.has('uploads') ? '?uploads' : '';
    log.push(`${req.method} ${key}${kind}`);

    if (req.method === 'HEAD' || req.method === 'GET') {
      const body = objects.get(key);
      if (!body) return s3_error(404, req.method === 'HEAD' ? 'NotFound' : 'NoSuchKey');
      return { status: 200, body };
    }
    if (req.method === 'PUT' && part) {
      on_body(req, (body) => parts.set(Number(part), body));
      return { status: 200, headers: { etag: `"part-${part}"` } };
    }
    if (req.method === 'PUT') {
      if (req.headers['if-none-match'] === '*' && objects.has(key)) {
        return s3_error(412, 'PreconditionFailed');
      }
      on_body(req, (body) => objects.set(key, body));
      return { status: 200 };
    }
    if (req.method === 'POST' && url.searchParams.has('uploads')) {
      parts.clear();
      return xml(
        `<InitiateMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>${key}</Key>` +
          `<UploadId>upload-1</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    if (req.method === 'POST' && upload_id) {
      const ordered = [...parts.entries()].sort(([a], [b]) => a - b).map(([, data]) => data);
      objects.set(key, Buffer.concat(ordered));
      return xml(
        `<CompleteMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>${key}</Key>` +
          `<ETag>"complete"</ETag></CompleteMultipartUploadResult>`,
      );
    }
    return { status: 204 };
  });

  return { fake, objects, log };
}

function context_on(bucket: FakeBucket): TenantContext {
  const storage = new S3ObjectStorage(bucket.fake.client, BUCKET, new BucketCache());
  return { tenant_id: 'tenant-1', storage } as unknown as TenantContext;
}

describe('drive replication through a real S3 client (issue #627)', () => {
  const opened: FakeS3[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((fake) => fake.close()));
  });

  it('streams a multi-part object with a single read and counts its bytes without a re-read', async () => {
    const payload = randomBytes(2 * REPLICATION_PART_BYTES + 4096);
    const source = await start_fake_bucket({
      '_meta/dek.enc': Buffer.from('wrapped-dek'),
      [DATA_KEY]: payload,
      [MANIFEST_KEY]: Buffer.from('encrypted-manifest'),
    });
    const target = await start_fake_bucket();
    opened.push(source.fake, target.fake);

    const tally = await replicate_drive_snapshot_objects(
      context_on(source),
      context_on(target),
      { entries: [{ storage_key: DATA_KEY }] },
      MANIFEST_KEY,
    );

    expect(tally.objects_failed).toBe(0);
    expect(tally.objects_copied).toBe(1);
    expect(tally.bytes_copied).toBe(payload.length);
    expect(source.log.filter((line) => line === `GET ${DATA_KEY}`)).toHaveLength(1);
    expect(target.log.filter((line) => line.startsWith(`PUT ${DATA_KEY}`))).toEqual([
      `PUT ${DATA_KEY}?part`,
      `PUT ${DATA_KEY}?part`,
      `PUT ${DATA_KEY}?part`,
    ]);
    expect(target.objects.get(DATA_KEY)?.equals(payload)).toBe(true);
    expect(target.objects.get(MANIFEST_KEY)?.toString()).toBe('encrypted-manifest');
  });

  it('writes a small object with one PutObject and still reads it once', async () => {
    const payload = randomBytes(1024);
    const source = await start_fake_bucket({
      '_meta/dek.enc': Buffer.from('wrapped-dek'),
      [DATA_KEY]: payload,
      [MANIFEST_KEY]: Buffer.from('encrypted-manifest'),
    });
    const target = await start_fake_bucket();
    opened.push(source.fake, target.fake);

    const tally = await replicate_drive_snapshot_objects(
      context_on(source),
      context_on(target),
      { entries: [{ storage_key: DATA_KEY }] },
      MANIFEST_KEY,
    );

    expect(tally.bytes_copied).toBe(1024);
    expect(source.log.filter((line) => line === `GET ${DATA_KEY}`)).toHaveLength(1);
    expect(target.log).not.toContain(`POST ${DATA_KEY}?uploads`);
    expect(target.objects.get(DATA_KEY)?.equals(payload)).toBe(true);
  });
});
