import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import {
  OUTLOOK_REHYDRATION,
  OUTLOOK_REPLICATION,
} from '@/services/replication/outlook-manifest-handler';
import {
  build_drive_rehydration_plan,
  build_drive_replication_plan,
} from '@/services/replication/drive-chain-copy-plan';
import {
  ONEDRIVE_REPLICATION,
  SHAREPOINT_REPLICATION,
} from '@/services/replication/drive-replication-descriptor';
import { replicate_chains_to_targets } from '@/services/replication/chain-replication-runner';
import type { SnapshotChainCopyPlan } from '@/services/replication/snapshot-chain-copier';
import { stub_storage_target } from '@wisecom/atlas-types/testing/stub-storage-target';

/**
 * Issue #191, carried over to the chain copy of issue #714. Outlook, OneDrive and SharePoint copy
 * through the same runner and differ only in their plans, which is exactly where one drifting from
 * the others goes unnoticed. So every plan is asserted on the same properties: whose chain a
 * manifest belongs to, and whether the replica marker is written.
 */
const tally = {
  objects_copied: 1,
  objects_skipped: 0,
  objects_failed: 0,
  bytes_copied: 10,
  errors: [] as string[],
  source_manifest_checksum: 'a',
  replicated_manifest_checksum: 'a',
};

vi.mock('@/services/replication/snapshot-replicator', () => ({
  replicate_snapshot_to_target: vi.fn(async () => tally),
}));
vi.mock('@/services/replication/drive-snapshot-replicator', () => ({
  replicate_drive_snapshot_objects: vi.fn(async () => tally),
}));
vi.mock('@/services/replication/replication-status-repository', () => ({
  save_replication_status: vi.fn(async () => undefined),
}));

import { replicate_snapshot_to_target } from '@/services/replication/snapshot-replicator';
import { replicate_drive_snapshot_objects } from '@/services/replication/drive-snapshot-replicator';
import { save_replication_status } from '@/services/replication/replication-status-repository';

const source_ctx = { tenant_id: 't', storage: {} } as unknown as TenantContext;
const created_at = new Date(1_000);

type AnyPlan = SnapshotChainCopyPlan<never>;

const workloads = [
  {
    name: 'outlook',
    manifest: { snapshot_id: 'snap-1', owner_id: 'mbx-1', created_at, entries: [] },
    owner: 'mbx-1',
    replicate: vi.mocked(replicate_snapshot_to_target),
    replication: OUTLOOK_REPLICATION as unknown as AnyPlan,
    rehydration: OUTLOOK_REHYDRATION as unknown as AnyPlan,
  },
  {
    name: 'onedrive',
    manifest: { snapshot_id: 'snap-1', owner_id: 'owner-1', created_at, entries: [] },
    owner: 'owner-1',
    replicate: vi.mocked(replicate_drive_snapshot_objects),
    replication: build_drive_replication_plan(ONEDRIVE_REPLICATION, []) as unknown as AnyPlan,
    rehydration: build_drive_rehydration_plan(ONEDRIVE_REPLICATION, []) as unknown as AnyPlan,
  },
  {
    name: 'sharepoint',
    manifest: { snapshot_id: 'snap-1', site_id: 'site-1', created_at, entries: [] },
    owner: 'site-1',
    replicate: vi.mocked(replicate_drive_snapshot_objects),
    replication: build_drive_replication_plan(SHAREPOINT_REPLICATION, []) as unknown as AnyPlan,
    rehydration: build_drive_rehydration_plan(SHAREPOINT_REPLICATION, []) as unknown as AnyPlan,
  },
];

/** The options object a plan passed to the workload replicator, if any. */
function replicator_options(replicate: ReturnType<typeof vi.fn>): { skip_marker?: boolean } {
  const last = replicate.mock.calls[0]?.at(-1) as { skip_marker?: boolean } | undefined;
  return last !== null && typeof last === 'object' && !('snapshot_id' in last) ? last : {};
}

describe.each(workloads)('$name chain copy plans', (w) => {
  const target_ctx = { tenant_id: 't', storage: {} } as unknown as TenantContext;

  beforeEach(() => {
    w.replicate.mockClear();
  });

  it('names the owner whose chain the manifest belongs to', () => {
    expect(w.replication.owner_of(w.manifest as never)).toBe(w.owner);
    expect(w.rehydration.owner_of(w.manifest as never)).toBe(w.owner);
  });

  it('keys the manifest under the owner on both sides', () => {
    const key = w.replication.manifest_key(w.manifest as never);

    expect(key).toContain(`/${w.owner}/snap-1.json`);
    expect(w.rehydration.manifest_key(w.manifest as never)).toBe(key);
  });

  it('suppresses the replica marker when rehydrating', async () => {
    await w.rehydration.copy(source_ctx, target_ctx, w.manifest as never, 'key');

    expect(replicator_options(w.replicate).skip_marker).toBe(true);
  });

  it('writes the replica marker when replicating', async () => {
    await w.replication.copy(source_ctx, target_ctx, w.manifest as never, 'key');

    expect(replicator_options(w.replicate).skip_marker).not.toBe(true);
  });
});

describe('replicate_chains_to_targets', () => {
  const plan = workloads[1]!.replication;
  const manifests = [
    { snapshot_id: 'snap-1', owner_id: 'owner-1', created_at: new Date(1_000), entries: [] },
    { snapshot_id: 'snap-2', owner_id: 'owner-1', created_at: new Date(2_000), entries: [] },
  ];

  beforeEach(() => {
    vi.mocked(replicate_drive_snapshot_objects).mockClear();
    vi.mocked(save_replication_status).mockClear();
  });

  function request(target: never, validate_dek = vi.fn(async () => undefined)) {
    return {
      source_ctx,
      targets: [target],
      manifests: manifests as never[],
      plan,
      to_status_record: () => ({}) as never,
      deps: { validate_dek, passphrase: 'p', tenant_id: 't' },
    };
  }

  it('validates the key once per target, copies each snapshot, and destroys the context', async () => {
    const stub = stub_storage_target({ target_id: 'replica' });
    const validate_dek = vi.fn(async () => undefined);

    const [outcome] = await replicate_chains_to_targets(
      request(stub.target as never, validate_dek),
    );

    expect(validate_dek).toHaveBeenCalledTimes(1);
    expect(outcome?.outcome.attempted).toHaveLength(2);
    expect(save_replication_status).toHaveBeenCalledTimes(2);
    expect(stub.created()).toBe(1);
    expect(stub.destroyed()).toBe(1);
  });

  it('destroys the context and copies nothing when the key check throws', async () => {
    const stub = stub_storage_target({ target_id: 'replica' });
    const validate_dek = vi.fn(async () => {
      throw new Error('DEK mismatch');
    });

    await expect(
      replicate_chains_to_targets(request(stub.target as never, validate_dek)),
    ).rejects.toThrow('DEK mismatch');

    expect(stub.destroyed()).toBe(1);
    expect(replicate_drive_snapshot_objects).not.toHaveBeenCalled();
  });
});
