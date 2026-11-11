import { describe, expect, it } from 'vitest';
import type { CalendarSnapshotManifest } from '@wisecom/atlas-types';
import { StorageError, UnreadableObjectsError } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { S3CalendarManifestRepository } from '@/adapters/s3-calendar-manifest-repository.adapter';
import { calendar_manifest_key } from '@/services/shared/storage-keys';

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';

function manifest(epoch: number, overrides: Partial<CalendarSnapshotManifest> = {}) {
  return {
    id: `id-${epoch}`,
    tenant_id: 'tenant-1',
    mailbox_id: MAILBOX,
    snapshot_id: `cal-snap-${epoch}-abc`,
    created_at: new Date(epoch).toISOString(),
    total_events: 1,
    total_size_bytes: 10,
    calendars: [{ calendar_id: 'f1', display_name: 'Calendar', is_default: true }],
    entries: [
      {
        event_id: `e-${epoch}`,
        calendar_id: 'f1',
        event_type: 'singleInstance',
        storage_key: 'k',
        checksum: 'x',
        size_bytes: 10,
      },
    ],
    ...overrides,
  } satisfies CalendarSnapshotManifest;
}

/** Stores two manifests and flips one byte of the newer one's ciphertext. */
async function two_snapshots_newer_damaged() {
  const harness = in_memory_tenant_context();
  const repo = new S3CalendarManifestRepository();
  await repo.save(harness.ctx, manifest(1000));
  await repo.save(harness.ctx, manifest(2000));
  const damaged_key = calendar_manifest_key(MAILBOX, 'cal-snap-2000-abc');
  const bytes = Buffer.from(harness.raw(damaged_key)!);
  bytes[bytes.length - 1]! ^= 0xff;
  harness.set_raw(damaged_key, bytes);
  return { harness, repo, damaged_key };
}

/** Encrypts `body` at the key of snapshot `cal-snap-3000-abc`, as a writer would have. */
function plant(harness: ReturnType<typeof in_memory_tenant_context>, body: string): string {
  const key = calendar_manifest_key(MAILBOX, 'cal-snap-3000-abc');
  harness.set_raw(key, harness.ctx.encrypt(Buffer.from(body), key));
  return key;
}

describe('S3CalendarManifestRepository with a damaged manifest (issue #631)', () => {
  it('lists the readable manifests and names the damaged key', async () => {
    const { harness, repo, damaged_key } = await two_snapshots_newer_damaged();

    const listing = await repo.list_readable_snapshots_by_mailbox(harness.ctx, MAILBOX);

    expect(listing.manifests.map((m) => m.snapshot_id)).toEqual(['cal-snap-1000-abc']);
    expect(listing.unreadable_keys).toEqual([damaged_key]);
  });

  it('falls back to the newest readable manifest and names the newer damaged one', async () => {
    const { harness, repo, damaged_key } = await two_snapshots_newer_damaged();

    const latest = await repo.find_latest_readable(harness.ctx, MAILBOX);

    expect(latest.manifest?.snapshot_id).toBe('cal-snap-1000-abc');
    expect(latest.unreadable_keys).toEqual([damaged_key]);
  });

  it('refuses to read the damaged snapshot itself, naming its key', async () => {
    const { harness, repo, damaged_key } = await two_snapshots_newer_damaged();

    const read = repo.find_by_snapshot(harness.ctx, MAILBOX, 'cal-snap-2000-abc');

    await expect(read).rejects.toBeInstanceOf(UnreadableObjectsError);
    await expect(read).rejects.toMatchObject({ unreadable_keys: [damaged_key] });
  });

  it('wraps a JSON parse failure with its cause instead of leaking a SyntaxError', async () => {
    const harness = in_memory_tenant_context();
    const key = plant(harness, '{"mailbox_id": ');

    const error = await new S3CalendarManifestRepository()
      .read_manifest_at(harness.ctx, key)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UnreadableObjectsError);
    expect((error as UnreadableObjectsError).code).toBe('ATLAS_CONTENT_UNREADABLE');
    expect((error as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it.each([
    ['entries missing', { entries: undefined }],
    ['calendars missing', { calendars: undefined }],
    ['an entry without its storage key', { entries: [{ event_id: 'e', checksum: 'x' }] }],
    ['created_at not a date', { created_at: 'not-a-date' }],
  ])('rejects a parsed body with %s', async (_label, overrides) => {
    const harness = in_memory_tenant_context();
    const key = plant(harness, JSON.stringify({ ...manifest(3000), ...overrides }));

    const read = new S3CalendarManifestRepository().read_manifest_at(harness.ctx, key);

    await expect(read).rejects.toMatchObject({ unreadable_keys: [key] });
  });

  it('keeps a storage failure a StorageError, never a damaged object', async () => {
    const harness = in_memory_tenant_context();
    const repo = new S3CalendarManifestRepository();
    await repo.save(harness.ctx, manifest(1000));
    harness.ctx.storage.get = async () => {
      throw new Error('connection reset');
    };

    const listing = repo.list_readable_snapshots_by_mailbox(harness.ctx, MAILBOX);

    await expect(listing).rejects.toBeInstanceOf(StorageError);
  });
});
