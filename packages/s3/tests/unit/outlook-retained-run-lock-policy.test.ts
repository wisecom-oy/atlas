import { describe, expect, it } from 'vitest';
import type { Manifest, ObjectStorage, TenantContext } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { record_lock_policies } from '@wisecom/atlas-types/testing/lock-policy-recorder';
import { ObjectLockingStorage } from '@wisecom/atlas-core/services/shared/run-object-lock';
import { S3MailboxDeltaCursorRepository } from '@/adapters/s3-mailbox-delta-cursor-repository.adapter';
import { S3ManifestRepository } from '@/adapters/s3-manifest-repository.adapter';

/**
 * Issue #919: cursors, pointers and the summary index are replaced on every run, so a lock on them
 * only keeps superseded versions alive. An Outlook run locks its manifest and content with the
 * policy it carries explicitly (content is covered in the outlook package's object-lock tests),
 * and its state stays unlocked even when written through a retained context.
 */

const OWNER = 'user@test.com';
const MANIFEST_KEY = 'manifests/user@test.com/snap-1.json';
const STATE_KEYS = [
  '_meta/outlook-cursors/user@test.com.json',
  '_meta/outlook-manifests/owners/user@test.com/latest.json',
  '_meta/outlook-manifests/owners/user@test.com/summary.json',
  '_meta/outlook-manifests/snapshots/snap-1.json',
].sort();
const RETAIN_UNTIL = '2030-01-01T00:00:00.000Z';

const MANIFEST: Manifest = {
  id: 'manifest-1',
  tenant_id: 'test-tenant',
  owner_id: OWNER,
  snapshot_id: 'snap-1',
  created_at: new Date('2026-01-15T10:00:00Z'),
  total_objects: 0,
  total_size_bytes: 0,
  delta_links: {},
  entries: [],
  object_lock: {
    requested: { mode: 'GOVERNANCE', retention_days: 30 },
    effective: { mode: 'GOVERNANCE', retain_until: RETAIN_UNTIL },
  },
};

/** Saves a retained run's manifest and cursor, returning the recorder under `decorate`. */
async function save_run(decorate: (storage: ObjectStorage) => ObjectStorage) {
  const harness = in_memory_tenant_context();
  const recorder = record_lock_policies(harness.ctx.storage);
  const ctx: TenantContext = { ...harness.ctx, storage: decorate(recorder.storage) };

  await new S3ManifestRepository().save(ctx, MANIFEST);
  await new S3MailboxDeltaCursorRepository().save(ctx, {
    owner_id: OWNER,
    delta_links: {},
    updated_at: '2026-01-01T00:00:00.000Z',
  });
  return recorder;
}

describe('Outlook writes under a retained run', () => {
  it('locks the manifest and leaves the cursor, pointers and summary unlocked', async () => {
    const recorder = await save_run((storage) => storage);

    expect(recorder.locked_keys()).toEqual([MANIFEST_KEY]);
    expect(recorder.unlocked_keys()).toEqual(STATE_KEYS);
  });

  it('keeps the state unlocked when the context carries the run retention', async () => {
    const policy = { mode: 'GOVERNANCE' as const, retain_until: RETAIN_UNTIL };
    const recorder = await save_run((storage) => new ObjectLockingStorage(storage, policy));

    expect(recorder.locked_keys()).toEqual([MANIFEST_KEY]);
    expect(recorder.unlocked_keys()).toEqual(STATE_KEYS);
  });
});
