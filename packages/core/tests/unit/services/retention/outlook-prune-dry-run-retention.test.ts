import { describe, expect, it } from 'vitest';
import type { SnapshotPruneResult } from '@wisecom/atlas-types';
import {
  OWNER,
  TENANT,
  bucket_state,
  manifest_key,
  prune_options,
  prune_service,
  seeded_bucket,
  type SeededRetention,
} from './outlook-prune.fixtures';

/** The counts a dry run predicts, which a run on the same bucket must then report. */
function counted(result: SnapshotPruneResult) {
  return {
    deleted_manifests: result.deleted_manifests,
    deleted_objects: result.deleted_objects,
    deleted_bytes: result.deleted_bytes,
    retained_manifests: result.retained_manifests,
    retained_objects: result.retained_objects,
    failed: result.failed_manifests + result.failed_objects,
    removed_snapshot_ids: [...result.removed_snapshot_ids].sort(),
    retained_manifest_keys: result.retained_manifest_keys,
    content_sweep_skipped: result.content_sweep_skipped,
  };
}

async function dry_then_real(retention: Record<string, SeededRetention>) {
  const bucket = await seeded_bucket(retention);
  const state = await bucket_state(bucket);
  const { service } = prune_service(bucket.storage);
  const dry = await service.prune_snapshots(TENANT, OWNER, prune_options({ dry_run: true }));
  expect(await bucket_state(bucket)).toBe(state);
  const real = await service.prune_snapshots(TENANT, OWNER, prune_options());
  return { dry, real };
}

describe('Outlook prune dry run under Object Lock', () => {
  it('predicts a pruned snapshot whose recorded retention still runs as retained, as the run finds it', async () => {
    const { dry, real } = await dry_then_real({ s1: 'running' });

    expect(counted(dry)).toEqual(counted(real));
    expect(dry.retained_manifest_keys).toEqual([manifest_key('s1')]);
    expect(dry.removed_snapshot_ids).toEqual(['s2']);
    // s1 stays and still references blobs b, c and attachment d, so neither run counts them.
    expect(dry.retained_manifests).toBe(1);
  });

  it('predicts a pruned snapshot whose recorded retention has ended as removed', async () => {
    const { dry, real } = await dry_then_real({ s1: 'ended' });

    expect(counted(dry)).toEqual(counted(real));
    expect(dry.removed_snapshot_ids.sort()).toEqual(['s1', 's2']);
    expect(dry.retained_manifest_keys).toEqual([]);
  });
});
