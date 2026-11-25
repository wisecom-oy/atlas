/**
 * Issue #881: under a Graph outage that outlasts the retry budget, a calendar backup spends one
 * budget, not one per calendar or event. Calendars finished before the outage are committed;
 * the failed calendar and those after it keep their previous entries and delta links.
 */

import 'reflect-metadata';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import { GraphUnavailableError, type GraphEventAttachment } from '@wisecom/atlas-types';
import {
  ATTEMPTS_PER_RETRY_CHAIN,
  GraphOutageFault,
  RETRY_BUDGET_SPAN_MS,
} from '@wisecom/atlas-types/testing/graph-outage-fault';
import {
  calendar,
  calendar_event,
  delta_of,
} from '@wisecom/atlas-types/testing/stub-calendar-ports';
import { calendar_rig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import { MAILBOX } from '@wisecom/atlas-types/testing/stub-calendar-snapshots';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';

import { CalendarBackupService } from '@/services/backup/backup.service';

const FILE_ATTACHMENT: GraphEventAttachment = {
  id: 'a1',
  name: 'agenda.pdf',
  kind: 'file',
  is_inline: false,
  size: 3,
};

/** Backup service over in-memory stores, with three calendars that each hold one event. */
async function baseline_harness() {
  const h = calendar_rig(
    (s) =>
      new CalendarBackupService(
        s.tenant_factory,
        s.connector,
        s.manifests,
        s.cursors,
        stub_owner_leases().leases,
      ),
  );
  h.script.calendars = [
    calendar('cal-default', 'Calendar', { is_default: true }),
    calendar('cal-work', 'Work'),
    calendar('cal-team', 'Team'),
  ];
  h.script.deltas = {
    'cal-default': delta_of('default-1', [calendar_event('e-default')]),
    'cal-work': delta_of('work-1', [calendar_event('e-work')]),
    'cal-team': delta_of('team-1', [calendar_event('e-team')]),
  };
  await h.service.backup_calendar('tenant-1', MAILBOX);
  return h;
}

function event_ids(entries: readonly { event_id: string; calendar_id: string }[], id: string) {
  return entries.filter((entry) => entry.calendar_id === id).map((entry) => entry.event_id);
}

describe('Calendar backup under a whole-run Graph outage (issue #881)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('spends one retry budget, commits finished calendars, and rejects with the outage', async () => {
    const h = await baseline_harness();
    h.script.deltas['cal-default'] = delta_of('default-2', [calendar_event('e-default-new')]);
    const graph = new GraphOutageFault();
    const read_delta = h.connector.fetch_event_delta.bind(h.connector);
    vi.spyOn(h.connector, 'fetch_event_delta').mockImplementation((...args) =>
      args[2] === 'cal-default' ? read_delta(...args) : with_graph_retry(graph.send),
    );

    const run = h.service.backup_calendar('tenant-1', MAILBOX).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(RETRY_BUDGET_SPAN_MS);
    const failure = await run;

    expect(failure).toBeInstanceOf(GraphUnavailableError);
    expect(graph.requests).toBe(ATTEMPTS_PER_RETRY_CHAIN);
    const entries = h.manifests.saved.at(-1)?.entries ?? [];
    expect(event_ids(entries, 'cal-default').sort()).toEqual(['e-default', 'e-default-new']);
    expect(event_ids(entries, 'cal-work')).toEqual(['e-work']);
    expect(event_ids(entries, 'cal-team')).toEqual(['e-team']);
    expect(h.cursors.saved.at(-1)?.delta_link_by_calendar).toEqual({
      'cal-default': 'default-2',
      'cal-work': 'work-1',
      'cal-team': 'team-1',
    });
  });
});

describe('Calendar event failures and the outage (issue #881)', () => {
  it('fails the whole calendar on an outage rather than one error per remaining event', async () => {
    const h = await baseline_harness();
    h.script.deltas['cal-default'] = delta_of('default-2', [calendar_event('e-default-new')]);
    h.script.deltas['cal-work'] = delta_of('work-2', [
      calendar_event('e-outage', { hasAttachments: true, subject: 'Outage' }),
      calendar_event('e-two'),
      calendar_event('e-three'),
    ]);
    h.script.attachments['e-outage'] = [FILE_ATTACHMENT];
    h.script.hooks = {
      attachment_content: () =>
        new GraphUnavailableError('Microsoft Graph was unavailable after 12 retries', {
          retries: 12,
          elapsed_ms: 1_411_000,
        }),
    };

    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(result.summary.errors).toEqual([
      'Calendar Work failed: Microsoft Graph was unavailable after 12 retries',
    ]);
    expect(event_ids(result.snapshot?.entries ?? [], 'cal-work')).toEqual(['e-work']);
    expect(h.cursors.saved.at(-1)?.delta_link_by_calendar['cal-work']).toBe('work-1');
  });

  it.each([
    ['an ordinary error', () => new Error('storage timeout')],
    ['a 404', () => Object.assign(new Error('Not Found'), { statusCode: 404 })],
  ])('still records %s against the one event and stores the rest', async (_name, make_error) => {
    const h = await baseline_harness();
    h.script.deltas['cal-work'] = delta_of('work-2', [
      calendar_event('e-broken', { hasAttachments: true, subject: 'Broken' }),
      calendar_event('e-two'),
    ]);
    h.script.attachments['e-broken'] = [FILE_ATTACHMENT];
    h.script.hooks = { attachment_content: make_error };

    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(result.summary.errors).toHaveLength(1);
    expect(result.summary.errors[0]).toMatch(/^Event "Broken" \(e-broken\) in Work failed: /);
    expect(event_ids(result.snapshot?.entries ?? [], 'cal-work').sort()).toEqual([
      'e-two',
      'e-work',
    ]);
    expect(h.cursors.saved.at(-1)?.delta_link_by_calendar['cal-work']).toBe('work-1');
  });
});
