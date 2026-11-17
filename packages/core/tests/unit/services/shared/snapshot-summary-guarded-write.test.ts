/**
 * The summary index goes through the guarded metadata writer like every other encrypted JSON
 * object: refused when its reader would treat it as absent, compare-and-swap on the ETag read, not
 * read back, and written only while the backup still holds the owner's lease (#625, #623).
 */
import { describe, expect, it, vi } from 'vitest';
import { OwnerLeaseLostError, RefusedWriteError } from '@wisecom/atlas-types';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import {
  build_snapshot_summary_document,
  require_snapshot_summary_document,
  SNAPSHOT_SUMMARY_FORMAT_VERSION,
} from '@/services/shared/snapshot-summary-document';
import { write_snapshot_summaries } from '@/services/shared/snapshot-summary-store';
import { record_snapshot_summary_or_warn } from '@/services/shared/snapshot-summary-writer';
import {
  LAYOUT,
  OWNER,
  counting_harness,
  fixture_manifest,
  store_manifest_only,
  summary_key,
} from './snapshot-summary.fixtures';

vi.mock('@/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** A built document after the JSON round trip the writer's check sees. */
function round_tripped(owner_id: string): unknown {
  return JSON.parse(JSON.stringify(build_snapshot_summary_document(owner_id, [])));
}

describe('require_snapshot_summary_document', () => {
  it('accepts the document the writer builds for that owner', () => {
    expect(require_snapshot_summary_document(OWNER, round_tripped(OWNER))).toEqual([]);
  });

  it.each([
    ['another owner', { ...(round_tripped(OWNER) as object), owner_id: 'owner-2' }],
    ['another format', { ...(round_tripped(OWNER) as object), format_version: 99 }],
    ['no rows array', { format_version: SNAPSHOT_SUMMARY_FORMAT_VERSION, owner_id: OWNER }],
    ['a non-object', [1, 2]],
  ])('rejects a document naming %s, which the reader reads as absent', (_case, value) => {
    expect(() => require_snapshot_summary_document(OWNER, value)).toThrow();
  });
});

describe('write_snapshot_summaries through the guarded writer', () => {
  it('refuses a body that cannot be serialised and writes nothing', async () => {
    const { harness } = counting_harness();
    const unserialisable = {
      toJSON(): never {
        throw new Error('not serialisable');
      },
    };

    const write = write_snapshot_summaries(
      harness.ctx,
      LAYOUT,
      OWNER,
      [unserialisable] as never,
      undefined,
    );

    await expect(write).rejects.toBeInstanceOf(RefusedWriteError);
    expect(harness.raw(summary_key(OWNER))).toBeUndefined();
  });

  it('does not read the summary back after writing it', async () => {
    const { harness } = counting_harness();
    const get = vi.spyOn(harness.ctx.storage, 'get');

    await write_snapshot_summaries(harness.ctx, LAYOUT, OWNER, [], undefined);

    expect(get.mock.calls).not.toContainEqual([summary_key(OWNER)]);
    expect(harness.raw(summary_key(OWNER))).toBeDefined();
  });
});

describe('record_snapshot_summary_or_warn under the owner lease', () => {
  it('checks the lease after reconciling and right before the write', async () => {
    const { harness } = counting_harness();
    const leases = stub_owner_leases();
    const lease = await leases.leases.acquire(harness.ctx, {
      workload: 'onedrive',
      owner_id: OWNER,
      operation: 'backup',
    });
    const manifest = fixture_manifest(1000);
    const key = await store_manifest_only(harness, manifest);

    await record_snapshot_summary_or_warn(
      harness.ctx,
      LAYOUT,
      OWNER,
      LAYOUT.summarize(manifest, key),
      lease,
    );

    expect(leases.events).toEqual(['acquire', 'assert']);
    expect(harness.raw(summary_key(OWNER))).toBeDefined();
  });

  it('raises a lost lease instead of logging it, and writes no summary', async () => {
    const { harness } = counting_harness();
    const leases = stub_owner_leases();
    const lease = await leases.leases.acquire(harness.ctx, {
      workload: 'onedrive',
      owner_id: OWNER,
      operation: 'backup',
    });
    leases.fail_checks_with(
      new OwnerLeaseLostError({ workload: 'onedrive', owner_id: OWNER }, 'it expired'),
    );
    const manifest = fixture_manifest(1000);
    const key = await store_manifest_only(harness, manifest);

    const record = record_snapshot_summary_or_warn(
      harness.ctx,
      LAYOUT,
      OWNER,
      LAYOUT.summarize(manifest, key),
      lease,
    );

    await expect(record).rejects.toBeInstanceOf(OwnerLeaseLostError);
    expect(harness.raw(summary_key(OWNER))).toBeUndefined();
  });
});
