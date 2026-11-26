import { describe, expect, it } from 'vitest';
import { crash_after_writes } from '@wisecom/atlas-types/testing/crash-after-writes';
import {
  OWNER,
  TENANT,
  current_state,
  prune_options,
  prune_service,
  restored_view,
  seeded_bucket,
} from './outlook-prune.fixtures';

/** The bucket after one prune that nothing interrupted, and how many writes that prune made. */
async function uninterrupted_outcome(): Promise<{ state: string; writes: number }> {
  const bucket = await seeded_bucket();
  const crashing = crash_after_writes(bucket.storage, Number.POSITIVE_INFINITY);
  await prune_service(crashing.storage).service.prune_snapshots(TENANT, OWNER, prune_options());
  return { state: await current_state(bucket), writes: crashing.writes() };
}

describe('Outlook snapshot prune, interrupted', () => {
  it('leaves restorable snapshots after a crash at any write, and a rerun ends in the same state', async () => {
    const expected = await uninterrupted_outcome();
    const reference = await seeded_bucket();
    const views = {
      s3: await restored_view(reference.storage, 's3'),
      s4: await restored_view(reference.storage, 's4'),
    };
    expect(expected.writes).toBeGreaterThan(3);

    for (let crash_at = 0; crash_at < expected.writes; crash_at++) {
      const bucket = await seeded_bucket();
      const crashing = crash_after_writes(bucket.storage, crash_at);
      // A write that fails mid-run either aborts the run or, for a delete, is counted as failed.
      await prune_service(crashing.storage)
        .service.prune_snapshots(TENANT, OWNER, prune_options())
        .catch((err: unknown) => expect(String(err)).toMatch(/simulated crash/));

      expect(await restored_view(bucket.storage, 's3'), `crash at ${crash_at}`).toBe(views.s3);
      expect(await restored_view(bucket.storage, 's4'), `crash at ${crash_at}`).toBe(views.s4);

      await prune_service(bucket.storage).service.prune_snapshots(TENANT, OWNER, prune_options());
      expect(await current_state(bucket), `rerun after crash at ${crash_at}`).toBe(expected.state);
    }
  });

  it('stops between steps when cancelled, and a rerun finishes the job', async () => {
    const expected = await uninterrupted_outcome();
    const bucket = await seeded_bucket();
    const controller = new AbortController();
    let checks = 0;
    const result = await prune_service(bucket.storage).service.prune_snapshots(
      TENANT,
      OWNER,
      prune_options({
        should_interrupt: () => {
          checks++;
          if (checks === 2) controller.abort();
          return controller.signal.aborted;
        },
      }),
    );
    expect(result.interrupted).toBe(true);
    expect(result.content_sweep_skipped).toBe('interrupted');

    const rerun = await prune_service(bucket.storage).service.prune_snapshots(
      TENANT,
      OWNER,
      prune_options(),
    );
    expect(rerun.interrupted).toBe(false);
    expect(await current_state(bucket)).toBe(expected.state);
  });
});
