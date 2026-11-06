import 'reflect-metadata';

import { AuthError, MailboxNotLicensedError } from '@wisecom/atlas-types';
import { calendar_event } from '@wisecom/atlas-types/testing/stub-calendar-ports';
import { calendar_rig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import {
  MAILBOX,
  SNAPSHOT,
  TENANT,
  save_snapshot,
  stored_event,
  stored_file,
} from '@wisecom/atlas-types/testing/stub-calendar-snapshots';
import { describe, expect, it } from 'vitest';

import { CalendarRestoreService } from '@/services/restore/restore.service';

/** Restore service over fresh in-memory stores. */
function restore_harness() {
  return calendar_rig(
    (s) => new CalendarRestoreService(s.tenant_factory, s.connector, s.manifests),
  );
}

describe('restore outcomes', () => {
  it('uploads a stored file attachment with its exact bytes after creating the event', async () => {
    const rig = restore_harness();
    const file = stored_file(rig.objects, 'att-1', 'agenda.pdf', 'PDF-BYTES');
    save_snapshot(rig.manifests, [
      stored_event(rig.objects, 'src-default', calendar_event('e-1'), [file]),
    ]);

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    const upload = rig.calls.uploads[0];
    expect(result.errors).toEqual([]);
    expect(rig.calls.uploads).toHaveLength(1);
    expect(upload?.event_id).toBe('evt-new-1');
    expect(upload?.attachment.name).toBe('agenda.pdf');
    expect(Buffer.from(upload?.attachment.content ?? []).toString('utf8')).toBe('PDF-BYTES');
  });

  it('keeps the event restored and reports an attachment the target refuses', async () => {
    const rig = restore_harness();
    rig.script.hooks = { upload_attachment: () => new Error('upload refused') };
    const file = stored_file(rig.objects, 'att-1', 'agenda.pdf', 'PDF-BYTES');
    save_snapshot(rig.manifests, [
      stored_event(rig.objects, 'src-default', calendar_event('e-1'), [file]),
    ]);

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(result.events_restored).toBe(1);
    expect(result.errors).toEqual([
      'Event "Event e-1" (e-1) restored, but attachment "agenda.pdf" not restored: upload refused',
    ]);
  });

  it('does not upload an attachment whose stored bytes fail their checksum', async () => {
    const rig = restore_harness();
    const file = stored_file(rig.objects, 'att-1', 'agenda.pdf', 'PDF-BYTES');
    save_snapshot(rig.manifests, [
      stored_event(rig.objects, 'src-default', calendar_event('e-1'), [
        { ...file, checksum: 'f'.repeat(64) },
      ]),
    ]);

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(rig.calls.uploads).toEqual([]);
    expect(result.errors).toEqual([
      'Event "Event e-1" (e-1) restored, but attachment "agenda.pdf" not restored: Attachment failed its checksum',
    ]);
  });

  it('fails an event whose stored object fails its checksum without creating it', async () => {
    const rig = restore_harness();
    const entry = stored_event(rig.objects, 'src-default', calendar_event('e-1'));
    save_snapshot(rig.manifests, [{ ...entry, checksum: 'f'.repeat(64) }]);

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(rig.calls.created_events).toEqual([]);
    expect(result.events_restored).toBe(0);
    expect(result.errors).toEqual([
      'Event "Event e-1" (e-1) failed to restore: Event object failed its checksum',
    ]);
  });

  it('stops before the next entry once the caller aborts during a create', async () => {
    const rig = restore_harness();
    const controller = new AbortController();
    rig.script.hooks = {
      create_event: () => {
        controller.abort();
        return undefined;
      },
    };
    save_snapshot(rig.manifests, [
      stored_event(rig.objects, 'src-default', calendar_event('e-1')),
      stored_event(rig.objects, 'src-default', calendar_event('e-2')),
    ]);

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, {
      snapshot_id: SNAPSHOT,
      abort_signal: controller.signal,
    });

    expect(result.interrupted).toBe(true);
    expect(result.events_restored).toBe(1);
    expect(rig.calls.created_events).toHaveLength(1);
  });

  it('restores nothing when the run is interrupted before it starts', async () => {
    const rig = restore_harness();
    save_snapshot(rig.manifests, [stored_event(rig.objects, 'src-default', calendar_event('e-1'))]);

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, {
      snapshot_id: SNAPSHOT,
      should_interrupt: () => true,
    });

    expect(result.interrupted).toBe(true);
    expect(result.events_restored).toBe(0);
    expect(rig.calls.created_events).toEqual([]);
  });

  it('records a refused event and continues with the next entry', async () => {
    const rig = restore_harness();
    rig.script.hooks = {
      create_event: (payload) =>
        payload['subject'] === 'Event e-1' ? new Error('throttled') : undefined,
    };
    save_snapshot(rig.manifests, [
      stored_event(rig.objects, 'src-default', calendar_event('e-1')),
      stored_event(rig.objects, 'src-default', calendar_event('e-2')),
    ]);

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(result.events_restored).toBe(1);
    expect(result.errors).toEqual(['Event "Event e-1" (e-1) failed to restore: throttled']);
    expect(rig.calls.created_events.map((c) => c.payload['subject'])).toEqual(['Event e-2']);
  });

  it.each([
    ['access is denied', new AuthError('token refused')],
    ['the mailbox is not licensed', new MailboxNotLicensedError('no license')],
  ])('ends the run after one attempt when %s', async (_label, error) => {
    const rig = restore_harness();
    let attempts = 0;
    rig.script.hooks = {
      create_event: () => {
        attempts += 1;
        return error;
      },
    };
    save_snapshot(rig.manifests, [
      stored_event(rig.objects, 'src-default', calendar_event('e-1')),
      stored_event(rig.objects, 'src-default', calendar_event('e-2')),
    ]);

    await expect(
      rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT }),
    ).rejects.toBe(error);
    expect(attempts).toBe(1);
  });
});
