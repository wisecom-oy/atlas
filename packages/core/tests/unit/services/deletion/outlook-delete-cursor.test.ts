/**
 * Issues #703 and #704: an Outlook delete left the mailbox's delta cursor behind, so the next
 * backup resumed past changes no remaining snapshot holds. And deleting an older snapshot dropped
 * the messages it recorded from every newer snapshot, because a newer snapshot folds the chain.
 */
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { OWNER_LEASES_TOKEN } from '@wisecom/atlas-types';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'reflect-metadata';
import { Container } from 'inversify';
import {
  MANIFEST_REPOSITORY_TOKEN,
  SnapshotNotNewestError,
  TENANT_CONTEXT_FACTORY_TOKEN,
  UnreadableObjectsError,
  type Manifest,
  type ManifestRepository,
  type TenantContext,
  type TenantContextFactory,
} from '@wisecom/atlas-types';
import { DeletionService } from '@/services/deletion/deletion.service';

const OWNER = 'john.doe@example.com';
const CURSOR_KEY = `_meta/outlook-cursors/${OWNER}.json`;

function make_manifest(snapshot_id: string, created_at: string): Manifest {
  return {
    id: snapshot_id,
    tenant_id: 't',
    owner_id: OWNER,
    snapshot_id,
    created_at: new Date(created_at),
    total_objects: 1,
    total_size_bytes: 1,
    delta_links: {},
    entries: [],
  };
}

const S1 = make_manifest('snap-1', '2026-03-01T10:00:00Z');
const S2 = make_manifest('snap-2', '2026-03-02T10:00:00Z');

/** A bucket of keys whose listing and deletes behave like an unversioned S3 backend. */
function make_bucket(initial: string[]): { keys: Set<string>; ctx: TenantContext } {
  const keys = new Set(initial);
  const storage = {
    list: vi.fn(async (prefix: string) => [...keys].filter((k) => k.startsWith(prefix)).sort()),
    list_versions: vi.fn(async () => []),
    delete: vi.fn(async (key: string) => void keys.delete(key)),
    delete_version: vi.fn(),
  };
  const ctx = { tenant_id: 't', storage, destroy: vi.fn() } as unknown as TenantContext;
  return { keys, ctx };
}

describe('Outlook deletion and the delta cursor', () => {
  let manifests: ManifestRepository;
  let bucket: ReturnType<typeof make_bucket>;
  let service: DeletionService;

  beforeEach(() => {
    bucket = make_bucket([
      `manifests/${OWNER}/snap-1.json`,
      `manifests/${OWNER}/snap-2.json`,
      `_meta/outlook-manifests/snapshots/snap-1.json`,
      `_meta/outlook-manifests/snapshots/snap-2.json`,
      `_meta/outlook-manifests/owners/${OWNER}/latest.json`,
      CURSOR_KEY,
      `_meta/replication/${OWNER}/snap-2/replica-a.json`,
      // A OneDrive snapshot of the same user shares the replication tree.
      `_meta/replication/${OWNER}/onedrive-snap/replica-a.json`,
      `_meta/outlook-cursors/someone.else@example.com.json`,
      `data/${OWNER}/aaa`,
    ]);
    manifests = {
      find_by_snapshot: vi.fn(async (_ctx, id: string) =>
        [S1, S2].find((m) => m.snapshot_id === id),
      ),
      list_by_owner: vi.fn(async () => [S1, S2]),
    } as unknown as ManifestRepository;
    const factory = {
      create: vi.fn(),
      create_readonly: vi.fn(async () => bucket.ctx),
      create_storage_only: vi.fn(async () => ({ tenant_id: 't', storage: bucket.ctx.storage })),
    } as unknown as TenantContextFactory;
    const container = new Container();
    container.bind(MANIFEST_REPOSITORY_TOKEN).toConstantValue(manifests);
    container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(factory);
    container.bind(OWNER_LEASES_TOKEN).toConstantValue(stub_owner_leases().leases);
    container.bind(DeletionService).toSelf();
    service = container.get(DeletionService);
  });

  it('delete -m removes the cursor and the deleted snapshots replication records only', async () => {
    await service.delete_mailbox_data('t', OWNER);

    expect(bucket.keys.has(CURSOR_KEY)).toBe(false);
    expect(bucket.keys.has(`_meta/replication/${OWNER}/snap-2/replica-a.json`)).toBe(false);
    expect([...bucket.keys].sort()).toEqual([
      `_meta/outlook-cursors/someone.else@example.com.json`,
      `_meta/replication/${OWNER}/onedrive-snap/replica-a.json`,
    ]);
  });

  it('delete -s of the newest snapshot removes it and the cursor that points past it', async () => {
    await service.delete_snapshot('t', 'snap-2');

    expect(bucket.keys.has(`manifests/${OWNER}/snap-2.json`)).toBe(false);
    expect(bucket.keys.has(CURSOR_KEY)).toBe(false);
    expect(bucket.keys.has(`manifests/${OWNER}/snap-1.json`)).toBe(true);
  });

  it('refuses delete -s of an older snapshot and deletes nothing', async () => {
    const before = [...bucket.keys];

    const refused = service.delete_snapshot('t', 'snap-1');

    await expect(refused).rejects.toBeInstanceOf(SnapshotNotNewestError);
    await expect(refused).rejects.toMatchObject({
      code: 'ATLAS_SNAPSHOT_NOT_NEWEST',
      snapshot_id: 'snap-1',
      newer_snapshot_ids: ['snap-2'],
    });
    expect([...bucket.keys]).toEqual(before);
  });

  it('treats a snapshot written at the same instant as newer', async () => {
    const twin = { ...make_manifest('snap-2b', '2026-03-02T10:00:00Z') };
    vi.mocked(manifests.list_by_owner).mockResolvedValue([S1, S2, twin]);

    await expect(service.delete_snapshot('t', 'snap-2')).rejects.toBeInstanceOf(
      SnapshotNotNewestError,
    );
  });

  it('refuses delete -s while a manifest of the mailbox is unreadable and names it', async () => {
    const damaged = `manifests/${OWNER}/snap-x.json`;
    vi.mocked(manifests.list_by_owner).mockRejectedValue(
      new UnreadableObjectsError('Some manifests are unreadable', [damaged]),
    );
    const before = [...bucket.keys];

    const refused = service.delete_snapshot('t', 'snap-2');

    await expect(refused).rejects.toBeInstanceOf(UnreadableObjectsError);
    await expect(refused).rejects.toMatchObject({ unreadable_keys: [damaged] });
    await expect(refused).rejects.toThrow(/quarantined/);
    expect([...bucket.keys]).toEqual(before);
  });
});
