import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  TeamsChannelEntry,
  TeamsManifestRepository,
  TeamsSnapshotManifest,
  TeamsStoredBlobRef,
  TeamsThreadEntry,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { ConfigError } from '@wisecom/atlas-types';
import {
  stub_encrypted_object_store,
  type StubEncryptedObjectStore,
} from '@wisecom/atlas-types/testing/stub-encrypted-object-store';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import { TeamsVerificationService } from '@/services/verification/verification.service';

const TEAM = 'a1b2c3d4-e5f6-4789-8abc-0123456789ab';
const SNAPSHOT = 'teams-snap-2000-bbbbbb';
const TIMESTAMP = '2025-01-01T00:00:00.000Z';

/** Stores one sealed blob in `bucket` and returns the reference a manifest would record for it. */
function put_blob(
  bucket: Map<string, Buffer>,
  store: StubEncryptedObjectStore,
  storage_key: string,
  plaintext: string,
): TeamsStoredBlobRef {
  const bytes = Buffer.from(plaintext, 'utf-8');
  bucket.set(storage_key, store.encrypt(bytes));
  return {
    storage_key,
    checksum: createHash('sha256').update(bytes).digest('hex'),
    size_bytes: bytes.length,
  };
}

function thread(own: TeamsStoredBlobRef, extra: Partial<TeamsThreadEntry> = {}): TeamsThreadEntry {
  return {
    ...own,
    last_modified_at: TIMESTAMP,
    reply_count: 0,
    hosted: {},
    backup_at: TIMESTAMP,
    ...extra,
  } as TeamsThreadEntry;
}

function manifest_with(threads: TeamsThreadEntry[]): TeamsSnapshotManifest {
  const channel = {
    id: 'channel-1',
    threads: Object.fromEntries(threads.map((entry, index) => [`root-${index}`, entry])),
  } as unknown as TeamsChannelEntry;
  return { team_id: TEAM, snapshot_id: SNAPSHOT, channels: [channel] } as TeamsSnapshotManifest;
}

/** Builds the service over an in-memory bucket. `manifest` is what `find_by_snapshot` returns. */
function setup(store: StubEncryptedObjectStore, bucket: Map<string, Buffer>) {
  const get = vi.fn(async (key: string) => {
    const body = bucket.get(key);
    if (body === undefined) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
    return body;
  });
  const ctx = {
    storage: { exists: vi.fn(async (key: string) => bucket.has(key)), get },
    decrypt: (payload: Buffer) => store.decrypt(payload),
    create_content_hmac: () => stub_tenant_create_content_hmac(),
    destroy: vi.fn(),
  } as unknown as TenantContext;
  const create_readonly = vi.fn(async () => ctx);
  const find_by_snapshot = vi.fn();
  const service = new TeamsVerificationService(
    { create_readonly } as unknown as TenantContextFactory,
    { find_by_snapshot } as unknown as TeamsManifestRepository,
  );
  return { get, create_readonly, find_by_snapshot, service };
}

describe('TeamsVerificationService.verify_teams_snapshot', () => {
  it('passes when every referenced blob matches its recorded size and checksum', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const own = put_blob(bucket, store, 'teams/data/t/own', 'hello');
    const hosted = put_blob(bucket, store, 'teams/data/t/hosted', 'image');
    const { service, find_by_snapshot } = setup(store, bucket);
    find_by_snapshot.mockResolvedValue(
      manifest_with([thread(own, { hosted: { h1: { ...hosted } } })]),
    );

    const result = await service.verify_teams_snapshot('tenant', TEAM, SNAPSHOT);

    expect(result).toMatchObject({ total_checked: 2, passed: 2, failed_storage_keys: [] });
  });

  it('flags a blob whose bytes no longer match its checksum and keeps checking the rest', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const tampered = put_blob(bucket, store, 'teams/data/t/a', 'original');
    const intact = put_blob(bucket, store, 'teams/data/t/b', 'intact');
    bucket.set(tampered.storage_key, store.encrypt(Buffer.from('replaced')));
    const { service, find_by_snapshot } = setup(store, bucket);
    find_by_snapshot.mockResolvedValue(manifest_with([thread(tampered), thread(intact)]));

    const result = await service.verify_teams_snapshot('tenant', TEAM, SNAPSHOT);

    expect(result).toMatchObject({
      total_checked: 2,
      passed: 1,
      failed_storage_keys: [tampered.storage_key],
    });
  });

  it('verifies the last live blob a deleted root kept, not only its tombstone (B3)', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const tombstone = put_blob(bucket, store, 'teams/data/t/tombstone', 'gone');
    const last_live = put_blob(bucket, store, 'teams/data/t/last-live', 'replies');
    bucket.set(last_live.storage_key, store.encrypt(Buffer.from('corrupted')));
    const { service, find_by_snapshot } = setup(store, bucket);
    find_by_snapshot.mockResolvedValue(
      manifest_with([thread(tombstone, { deleted_at: TIMESTAMP, last_live: { ...last_live } })]),
    );

    const result = await service.verify_teams_snapshot('tenant', TEAM, SNAPSHOT);

    expect(result).toMatchObject({
      total_checked: 2,
      failed_storage_keys: [last_live.storage_key],
    });
  });

  it('verifies last_live on a live thread whose replies were since deleted (M9)', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const live = put_blob(bucket, store, 'teams/data/t/live', 'current replies');
    const last_live = put_blob(bucket, store, 'teams/data/t/last-live', 'replies before delete');
    bucket.set(last_live.storage_key, store.encrypt(Buffer.from('corrupted')));
    const { service, find_by_snapshot } = setup(store, bucket);
    find_by_snapshot.mockResolvedValue(
      manifest_with([thread(live, { last_live: { ...last_live } })]),
    );

    const result = await service.verify_teams_snapshot('tenant', TEAM, SNAPSHOT);

    expect(result).toMatchObject({
      total_checked: 2,
      failed_storage_keys: [last_live.storage_key],
    });
  });

  it('in fast mode checks existence only, so a corrupted but present blob passes and a missing one fails (B9)', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const corrupted = put_blob(bucket, store, 'teams/data/t/corrupted', 'original');
    bucket.set(corrupted.storage_key, store.encrypt(Buffer.from('replaced')));
    const missing = put_blob(bucket, store, 'teams/data/t/missing', 'absent');
    bucket.delete(missing.storage_key);
    const { service, find_by_snapshot, get } = setup(store, bucket);
    find_by_snapshot.mockResolvedValue(manifest_with([thread(corrupted), thread(missing)]));

    const result = await service.verify_teams_snapshot('tenant', TEAM, SNAPSHOT, { fast: true });

    expect(result.failed_storage_keys).toEqual([missing.storage_key]);
    expect(get).not.toHaveBeenCalled();
  });

  it('emits discovering, per-blob processing, finalizing, then a terminal event (B9)', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const first = put_blob(bucket, store, 'teams/data/t/first', 'one');
    const second = put_blob(bucket, store, 'teams/data/t/second', 'two');
    const { service, find_by_snapshot } = setup(store, bucket);
    find_by_snapshot.mockResolvedValue(manifest_with([thread(first), thread(second)]));
    const on_progress = vi.fn();

    await service.verify_teams_snapshot('tenant', TEAM, SNAPSHOT, { on_progress });

    expect(on_progress.mock.calls.map(([event]) => event.phase)).toEqual([
      'discovering',
      'processing',
      'processing',
      'processing',
      'finalizing',
      'completed',
    ]);
  });

  it('stops between blobs and reports interrupted when cancellation is requested (B9)', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const first = put_blob(bucket, store, 'teams/data/t/first', 'one');
    const second = put_blob(bucket, store, 'teams/data/t/second', 'two');
    const { service, find_by_snapshot } = setup(store, bucket);
    find_by_snapshot.mockResolvedValue(manifest_with([thread(first), thread(second)]));
    // Calls: begin (false), blob 1 (false), blob 2 (true).
    let calls = 0;

    const result = await service.verify_teams_snapshot('tenant', TEAM, SNAPSHOT, {
      should_interrupt: () => ++calls > 2,
    });

    expect(result).toMatchObject({ total_checked: 1, passed: 1, interrupted: true });
  });

  it('normalizes an uppercase team id before the manifest lookup (A9)', async () => {
    const store = stub_encrypted_object_store();
    const { service, find_by_snapshot } = setup(store, new Map());
    find_by_snapshot.mockResolvedValue(undefined);

    await expect(
      service.verify_teams_snapshot('tenant', TEAM.toUpperCase(), SNAPSHOT),
    ).rejects.toThrow();
    expect(find_by_snapshot).toHaveBeenCalledWith(expect.anything(), TEAM, SNAPSHOT);
  });

  it('rejects a team id that is not a GUID before opening storage (A9)', async () => {
    const store = stub_encrypted_object_store();
    const { service, create_readonly } = setup(store, new Map());

    await expect(service.verify_teams_snapshot('tenant', 'not-a-guid', SNAPSHOT)).rejects.toThrow(
      ConfigError,
    );
    expect(create_readonly).not.toHaveBeenCalled();
  });
});
