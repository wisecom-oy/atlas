import { describe, expect, it } from 'vitest';
import { crash_after_writes } from '@wisecom/atlas-types/testing/crash-after-writes';
import {
  current_state,
  prune,
  restored_view,
  seeded_bucket,
  snapshot_id,
  type Workload,
} from './drive-prune.fixtures';

describe.each<Workload>(['onedrive', 'sharepoint'])(
  '%s snapshot prune, interrupted',
  (workload) => {
    it('leaves restorable snapshots after a crash at any write, and a rerun ends in the same state', async () => {
      const reference = await seeded_bucket(workload);
      const counting = crash_after_writes(reference.storage, Number.POSITIVE_INFINITY);
      const views = [
        await restored_view(reference.storage, workload, snapshot_id(3)),
        await restored_view(reference.storage, workload, snapshot_id(4)),
      ];
      await prune(counting.storage, workload);
      const expected = await current_state(reference);
      expect(counting.writes()).toBeGreaterThan(4);

      for (let crash_at = 0; crash_at < counting.writes(); crash_at++) {
        const bucket = await seeded_bucket(workload);
        const crashing = crash_after_writes(bucket.storage, crash_at);
        await prune(crashing.storage, workload).catch((err: unknown) =>
          expect(String(err)).toMatch(/simulated crash/),
        );

        expect(
          await restored_view(bucket.storage, workload, snapshot_id(3)),
          `crash at ${crash_at}`,
        ).toBe(views[0]);
        expect(
          await restored_view(bucket.storage, workload, snapshot_id(4)),
          `crash at ${crash_at}`,
        ).toBe(views[1]);

        await prune(bucket.storage, workload);
        expect(await current_state(bucket), `rerun after crash at ${crash_at}`).toBe(expected);
      }
    });
  },
);
