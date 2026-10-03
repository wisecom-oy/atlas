import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { VerificationService } from '@/services/verification/verification.service';
import type {
  Manifest,
  ManifestEntry,
  ManifestRepository,
  ObjectStorage,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';

const PLAINTEXT = Buffer.from('message body');
const CHECKSUM = createHash('sha256').update(PLAINTEXT).digest('hex');

/** An S3 SDK error as the client raises it: a name plus the response status. */
function s3_error(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

function make_entries(count: number): ManifestEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    object_id: `obj-${i}`,
    storage_key: `data/mailbox/key-${i}`,
    checksum: CHECKSUM,
    size_bytes: PLAINTEXT.length,
  }));
}

function make_service(entries: ManifestEntry[], storage: Partial<ObjectStorage>) {
  const decrypt = vi.fn((data: Buffer) => {
    if (data.toString() === 'tampered') {
      throw new Error('Unsupported state or unable to authenticate data');
    }
    return data;
  });
  const ctx = { tenant_id: 't', storage, decrypt, destroy: vi.fn() } as unknown as TenantContext;
  const manifest: Manifest = {
    id: 'm-1',
    tenant_id: 't',
    owner_id: 'mailbox-1',
    snapshot_id: 'snap-1',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    total_objects: entries.length,
    total_size_bytes: 0,
    delta_links: {},
    entries,
  };
  const manifests = {
    find_by_snapshot: vi.fn().mockResolvedValue(manifest),
    list_all_manifests: vi.fn().mockResolvedValue([]),
  } as unknown as ManifestRepository;
  const factory = {
    create_readonly: vi.fn().mockResolvedValue(ctx),
  } as unknown as TenantContextFactory;
  return new VerificationService(factory, manifests);
}

describe('Outlook verify separates damage from storage failures (issue #439)', () => {
  it('counts an absent object and a tampered object as failed in full mode', async () => {
    const [absent, tampered, intact] = make_entries(3);
    const get = vi.fn(async (key: string) => {
      if (key === absent!.storage_key) throw s3_error('NoSuchKey', 404);
      return key === tampered!.storage_key ? Buffer.from('tampered') : PLAINTEXT;
    });
    const service = make_service([absent!, tampered!, intact!], { get });

    const result = await service.verify_snapshot_integrity('t', 'snap-1');

    expect(result.failed).toEqual([absent!.object_id, tampered!.object_id]);
    expect(result.passed).toBe(1);
  });

  it('propagates a 403 in full mode and stops reading further objects', async () => {
    const entries = make_entries(40);
    const get = vi.fn().mockRejectedValue(s3_error('AccessDenied', 403));
    const service = make_service(entries, { get });

    await expect(service.verify_snapshot_integrity('t', 'snap-1')).rejects.toMatchObject({
      $metadata: { httpStatusCode: 403 },
    });
    expect(get.mock.calls.length).toBeLessThan(entries.length);
  });

  it('counts an absent object as failed and propagates a 503 in fast mode', async () => {
    const entries = make_entries(1);
    const absent = make_service(entries, { exists: vi.fn().mockResolvedValue(false) });
    const throttled = make_service(entries, {
      exists: vi.fn().mockRejectedValue(s3_error('SlowDown', 503)),
    });

    const result = await absent.verify_snapshot_integrity('t', 'snap-1', { fast: true });

    expect(result.failed).toEqual([entries[0]!.object_id]);
    await expect(
      throttled.verify_snapshot_integrity('t', 'snap-1', { fast: true }),
    ).rejects.toMatchObject({ name: 'SlowDown' });
  });
});
