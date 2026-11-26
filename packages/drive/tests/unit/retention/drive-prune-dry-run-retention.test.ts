import { describe, expect, it } from 'vitest';
import type { SnapshotPruneResult } from '@wisecom/atlas-types';
import {
  OWNER,
  bucket_state,
  keys_of,
  prune,
  seeded_bucket,
  snapshot_id,
  type SeededRetention,
  type Workload,
} from './drive-prune.fixtures';

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

describe.each<Workload>(['onedrive', 'sharepoint'])(
  '%s prune dry run under Object Lock',
  (workload) => {
    async function dry_then_real(retention: Record<number, SeededRetention>) {
      const bucket = await seeded_bucket(workload, retention);
      const state = await bucket_state(bucket);
      const dry = await prune(bucket.storage, workload, { dry_run: true });
      expect(await bucket_state(bucket)).toBe(state);
      const real = await prune(bucket.storage, workload);
      return { dry, real };
    }

    it('predicts a pruned snapshot whose recorded retention still runs as retained, as the run finds it', async () => {
      const { dry, real } = await dry_then_real({ 1: 'running' });

      expect(counted(dry)).toEqual(counted(real));
      expect(dry.retained_manifest_keys).toEqual([
        keys_of(workload).manifest_key(OWNER, snapshot_id(1)),
      ]);
      // Its run index, entry parts, the old version it captured and its blobs stay with it.
      expect(dry.removed_snapshot_ids).toEqual([snapshot_id(2)]);
    });

    it('predicts a pruned snapshot whose recorded retention has ended as removed', async () => {
      const { dry, real } = await dry_then_real({ 1: 'ended' });

      expect(counted(dry)).toEqual(counted(real));
      expect(dry.removed_snapshot_ids.sort()).toEqual([snapshot_id(1), snapshot_id(2)].sort());
    });
  },
);
