import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import { calendar_rig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import {
  MAILBOX,
  SNAPSHOT,
  TENANT,
  save_snapshot,
  stored_event,
  stored_file,
} from '@wisecom/atlas-types/testing/stub-calendar-snapshots';

import { CalendarVerificationService } from '@/services/verification/verification.service';

/** Verification service over in-memory stores. */
function verification_harness() {
  return calendar_rig((s) => new CalendarVerificationService(s.tenant_factory, s.manifests));
}

describe('CalendarVerificationService', () => {
  it('passes the event and each file attachment in fast mode when all are present', async () => {
    const h = verification_harness();
    const attachment = stored_file(h.objects, 'a1', 'agenda.pdf', 'agenda');
    save_snapshot(h.manifests, [
      stored_event(h.objects, 'src-default', { id: 'e1', type: 'singleInstance' }, [attachment]),
    ]);

    const result = await h.service.verify_calendar_snapshot(TENANT, MAILBOX, SNAPSHOT, {
      fast: true,
    });

    expect(result.total_checked).toBe(2);
    expect(result.passed).toBe(2);
    expect(result.failed).toEqual([]);
    expect(result.interrupted).toBe(false);
  });

  it('trusts a present object in fast mode without reading its bytes', async () => {
    const h = verification_harness();
    const entry = stored_event(h.objects, 'src-default', { id: 'e1', type: 'singleInstance' });
    save_snapshot(h.manifests, [entry]);
    h.objects[entry.storage_key] = Buffer.from('tampered');

    const result = await h.service.verify_calendar_snapshot(TENANT, MAILBOX, SNAPSHOT, {
      fast: true,
    });

    expect(result.passed).toBe(1);
    expect(result.failed).toEqual([]);
  });

  it('counts an absent attachment as failed and keeps checking the rest', async () => {
    const h = verification_harness();
    const attachment = stored_file(h.objects, 'a1', 'agenda.pdf', 'agenda');
    const entry = stored_event(h.objects, 'src-default', { id: 'e1', type: 'singleInstance' }, [
      attachment,
    ]);
    save_snapshot(h.manifests, [entry]);
    delete h.objects[attachment.storage_key];

    const result = await h.service.verify_calendar_snapshot(TENANT, MAILBOX, SNAPSHOT, {
      fast: true,
    });

    expect(result.total_checked).toBe(2);
    expect(result.passed).toBe(1);
    expect(result.failed).toEqual([attachment.storage_key]);
  });

  it('passes in full mode when stored bytes still match the recorded checksums', async () => {
    const h = verification_harness();
    const attachment = stored_file(h.objects, 'a1', 'agenda.pdf', 'agenda');
    save_snapshot(h.manifests, [
      stored_event(h.objects, 'src-default', { id: 'e1', type: 'singleInstance' }, [attachment]),
    ]);

    const result = await h.service.verify_calendar_snapshot(TENANT, MAILBOX, SNAPSHOT, {
      fast: false,
    });

    expect(result.passed).toBe(2);
    expect(result.failed).toEqual([]);
  });

  it('fails in full mode an event whose bytes no longer match, and keeps checking the others', async () => {
    const h = verification_harness();
    const tampered = stored_event(h.objects, 'src-default', { id: 'e1', type: 'singleInstance' });
    const intact = stored_event(h.objects, 'src-work', { id: 'e2', type: 'singleInstance' });
    save_snapshot(h.manifests, [tampered, intact]);
    h.objects[tampered.storage_key] = Buffer.from('tampered');

    const result = await h.service.verify_calendar_snapshot(TENANT, MAILBOX, SNAPSHOT, {
      fast: false,
    });

    expect(result.total_checked).toBe(2);
    expect(result.passed).toBe(1);
    expect(result.failed).toEqual([tampered.storage_key]);
  });

  it('counts an absent object as failed in full mode instead of throwing', async () => {
    const h = verification_harness();
    const entry = stored_event(h.objects, 'src-default', { id: 'e1', type: 'singleInstance' });
    save_snapshot(h.manifests, [entry]);
    delete h.objects[entry.storage_key];

    const result = await h.service.verify_calendar_snapshot(TENANT, MAILBOX, SNAPSHOT, {
      fast: false,
    });

    expect(result.passed).toBe(0);
    expect(result.failed).toEqual([entry.storage_key]);
  });

  it('checks nothing and reports interrupted when interrupted before the first object', async () => {
    const h = verification_harness();
    save_snapshot(h.manifests, [
      stored_event(h.objects, 'src-default', { id: 'e1', type: 'singleInstance' }),
    ]);

    const result = await h.service.verify_calendar_snapshot(TENANT, MAILBOX, SNAPSHOT, {
      fast: true,
      should_interrupt: () => true,
    });

    expect(result.interrupted).toBe(true);
    expect(result.total_checked).toBe(0);
  });

  it('throws NotFoundError when the snapshot manifest does not exist', async () => {
    const h = verification_harness();

    await expect(
      h.service.verify_calendar_snapshot(TENANT, MAILBOX, 'cal-snap-missing'),
    ).rejects.toThrow(/No calendar snapshot cal-snap-missing/);
  });
});
