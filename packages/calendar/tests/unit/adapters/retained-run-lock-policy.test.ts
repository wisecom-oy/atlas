import { describe, expect, it } from 'vitest';
import type { CalendarSnapshotManifest, TenantContext } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { record_lock_policies } from '@wisecom/atlas-types/testing/lock-policy-recorder';
import { ObjectLockingStorage } from '@wisecom/atlas-core/services/shared/run-object-lock';
import { S3CalendarDeltaCursorRepository } from '@/adapters/s3-calendar-delta-cursor-repository.adapter';
import { S3CalendarManifestRepository } from '@/adapters/s3-calendar-manifest-repository.adapter';
import { put_content_if_absent } from '@/services/shared/content-objects';
import {
  calendar_data_key,
  calendar_delta_cursor_key,
  calendar_manifest_key,
  calendar_summary_key,
} from '@/services/shared/storage-keys';

/**
 * Issue #919: a run with `--retention-days` locked every cursor and summary index version it
 * wrote, which the noncurrent-version rule could then not expire. Backup data keeps the lock.
 */

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';
const SNAPSHOT = 'cal-snap-1000-abc';
const RUN_POLICY = { mode: 'GOVERNANCE' as const, retain_until: '2030-01-01T00:00:00.000Z' };

function retained_run() {
  const harness = in_memory_tenant_context();
  const recorder = record_lock_policies(harness.ctx.storage);
  const ctx: TenantContext = {
    ...harness.ctx,
    storage: new ObjectLockingStorage(recorder.storage, RUN_POLICY),
  };
  return { ctx, recorder };
}

describe('Calendar writes under a retained run', () => {
  it('locks content and the manifest, and leaves the cursor and summary unlocked', async () => {
    const { ctx, recorder } = retained_run();
    const content_key = calendar_data_key(MAILBOX, 'content-name');
    const manifest: CalendarSnapshotManifest = {
      id: 'id-1000',
      tenant_id: 'tenant-1',
      mailbox_id: MAILBOX,
      snapshot_id: SNAPSHOT,
      created_at: new Date(1000).toISOString(),
      total_events: 1,
      total_size_bytes: 7,
      calendars: [{ calendar_id: 'cal-1', display_name: 'Calendar', is_default: true }],
      entries: [
        {
          event_id: 'e-1',
          calendar_id: 'cal-1',
          event_type: 'singleInstance',
          storage_key: content_key,
          checksum: 's',
          size_bytes: 7,
        },
      ],
    };

    await put_content_if_absent(ctx, content_key, Buffer.from('event'));
    await new S3CalendarManifestRepository().save(ctx, manifest);
    await new S3CalendarDeltaCursorRepository().save(ctx, {
      mailbox_id: MAILBOX,
      delta_link_by_calendar: {},
      updated_at: '2026-01-01T00:00:00.000Z',
    });

    expect(recorder.locked_keys()).toEqual(
      [content_key, calendar_manifest_key(MAILBOX, SNAPSHOT)].sort(),
    );
    expect(recorder.unlocked_keys()).toEqual(
      [calendar_delta_cursor_key(MAILBOX), calendar_summary_key(MAILBOX)].sort(),
    );
  });
});
