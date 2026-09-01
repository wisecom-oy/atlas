import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CopyDeps } from '@/services/replication/outlook-snapshot-copier';
import type { TenantContext } from '@wisecom/atlas-types';
import {
  copy_outlook_snapshot_between,
  copy_outlook_snapshot_to_target,
} from '@/services/replication/outlook-snapshot-copier';
import {
  copy_drive_snapshot_between,
  copy_drive_snapshot_into_context,
  copy_drive_snapshot_to_target,
} from '@/services/replication/drive-snapshot-copier';
import {
  ONEDRIVE_REPLICATION,
  SHAREPOINT_REPLICATION,
} from '@/services/replication/drive-replication-descriptor';
import { stub_storage_target } from '@wisecom/atlas-types/testing/stub-storage-target';

/**
 * Issue #191. These are the three entry points a replication or rehydration copy goes through, and
 * they differ only in who owns the context and who validated the DEK. That is exactly the kind of
 * near-duplicate trio where one drifting from the others goes unnoticed, so all three are asserted
 * on the same three properties.
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

import { replicate_snapshot_to_target } from '@/services/replication/snapshot-replicator';
import { replicate_drive_snapshot_objects } from '@/services/replication/drive-snapshot-replicator';

const source_ctx = { tenant_id: 't', storage: {} } as unknown as TenantContext;

function open_ctx(): { ctx: TenantContext; destroyed: () => number } {
  let destroyed = 0;
  const ctx = {
    tenant_id: 't',
    storage: {},
    destroy: () => {
      destroyed++;
    },
  } as unknown as TenantContext;
  return { ctx, destroyed: () => destroyed };
}

const onedrive_manifest = { snapshot_id: 'snap-1', owner_id: 'owner-1' } as never;
const sharepoint_manifest = { snapshot_id: 'snap-1', site_id: 'site-1' } as never;
const outlook_manifest = { snapshot_id: 'snap-1', mailbox_id: 'mbx-1' } as never;

function make_deps(validate_dek = vi.fn(async () => undefined)): CopyDeps & {
  validate_dek: ReturnType<typeof vi.fn>;
} {
  return { validate_dek, passphrase: 'p', tenant_id: 't' } as never;
}

const workloads = [
  {
    name: 'outlook',
    manifest: outlook_manifest,
    replicate: vi.mocked(replicate_snapshot_to_target),
    to_target: (target: never, deps: CopyDeps) =>
      copy_outlook_snapshot_to_target(source_ctx, target, outlook_manifest, deps),
    between: (target_ctx: TenantContext, deps: CopyDeps, is_rehydration?: boolean) =>
      copy_outlook_snapshot_between(
        source_ctx,
        target_ctx,
        outlook_manifest,
        'replica',
        deps,
        is_rehydration,
      ),
  },
  {
    name: 'onedrive',
    manifest: onedrive_manifest,
    descriptor: ONEDRIVE_REPLICATION,
    replicate: vi.mocked(replicate_drive_snapshot_objects),
    to_target: (target: never, deps: CopyDeps) =>
      copy_drive_snapshot_to_target(
        ONEDRIVE_REPLICATION,
        source_ctx,
        target,
        onedrive_manifest,
        [],
        deps,
      ),
    between: (target_ctx: TenantContext, deps: CopyDeps, is_rehydration?: boolean) =>
      copy_drive_snapshot_between(
        ONEDRIVE_REPLICATION,
        source_ctx,
        target_ctx,
        onedrive_manifest,
        [],
        'replica',
        deps,
        is_rehydration,
      ),
  },
  {
    name: 'sharepoint',
    manifest: sharepoint_manifest,
    descriptor: SHAREPOINT_REPLICATION,
    replicate: vi.mocked(replicate_drive_snapshot_objects),
    to_target: (target: never, deps: CopyDeps) =>
      copy_drive_snapshot_to_target(
        SHAREPOINT_REPLICATION,
        source_ctx,
        target,
        sharepoint_manifest,
        [],
        deps,
      ),
    between: (target_ctx: TenantContext, deps: CopyDeps, is_rehydration?: boolean) =>
      copy_drive_snapshot_between(
        SHAREPOINT_REPLICATION,
        source_ctx,
        target_ctx,
        sharepoint_manifest,
        [],
        'replica',
        deps,
        is_rehydration,
      ),
  },
];

describe.each(workloads)('$name snapshot copier', (w) => {
  beforeEach(() => {
    w.replicate.mockClear();
  });

  describe('to_target', () => {
    it('opens a context, validates the DEK, copies, and destroys the context', async () => {
      const stub = stub_storage_target({ target_id: 'replica' });
      const deps = make_deps();

      const result = await w.to_target(stub.target as never, deps);

      expect(deps.validate_dek).toHaveBeenCalledTimes(1);
      expect(w.replicate).toHaveBeenCalledTimes(1);
      expect(stub.destroyed()).toBe(1);
      expect(result.snapshot_id).toBe('snap-1');
    });

    it('destroys the context when validation throws', async () => {
      const stub = stub_storage_target({ target_id: 'replica' });
      const deps = make_deps(
        vi.fn(() => {
          throw new Error('DEK mismatch');
        }) as never,
      );

      await expect(w.to_target(stub.target as never, deps)).rejects.toThrow('DEK mismatch');

      expect(stub.destroyed()).toBe(1);
      expect(w.replicate).not.toHaveBeenCalled();
    });
  });

  describe('between', () => {
    it('validates the DEK and copies without touching the caller-owned context', async () => {
      const target = open_ctx();
      const deps = make_deps();

      await w.between(target.ctx, deps);

      expect(deps.validate_dek).toHaveBeenCalledTimes(1);
      expect(w.replicate).toHaveBeenCalledTimes(1);
      // The caller opened it, so the caller closes it.
      expect(target.destroyed()).toBe(0);
    });

    it('suppresses the replica marker when rehydrating', async () => {
      const target = open_ctx();

      await w.between(target.ctx, make_deps(), true);

      const options = w.replicate.mock.calls[0]?.at(-1) as { skip_marker?: boolean };
      expect(options.skip_marker).toBe(true);
    });

    it('writes the replica marker when replicating', async () => {
      const target = open_ctx();

      await w.between(target.ctx, make_deps(), false);

      const options = w.replicate.mock.calls[0]?.at(-1) as { skip_marker?: boolean };
      expect(options.skip_marker).toBe(false);
    });
  });
});

describe('drive into_context', () => {
  beforeEach(() => {
    vi.mocked(replicate_drive_snapshot_objects).mockClear();
  });

  it('copies without validating, because the loop validated once per target', async () => {
    const target = open_ctx();

    await copy_drive_snapshot_into_context(
      ONEDRIVE_REPLICATION,
      source_ctx,
      target.ctx,
      onedrive_manifest,
      [],
      'replica',
    );
    await copy_drive_snapshot_into_context(
      SHAREPOINT_REPLICATION,
      source_ctx,
      target.ctx,
      sharepoint_manifest,
      [],
      'replica',
    );

    expect(replicate_drive_snapshot_objects).toHaveBeenCalledTimes(2);
    expect(target.destroyed()).toBe(0);
  });
});
