import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import 'reflect-metadata';

import type { GraphEventPayload } from '@wisecom/atlas-types';
import { calendar_event } from '@wisecom/atlas-types/testing/stub-calendar-ports';
import { calendar_rig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import {
  MAILBOX,
  SNAPSHOT,
  SOURCE_ICAL_UID_TAG_ID,
  SOURCE_TAG_ID,
  TENANT,
  save_snapshot,
  stored_event,
} from '@wisecom/atlas-types/testing/stub-calendar-snapshots';
import { describe, expect, it } from 'vitest';

import { CalendarRestoreService } from '@/services/restore/restore.service';

/** Restore service over fresh in-memory stores. */
function restore_harness() {
  return calendar_rig(
    (s) =>
      new CalendarRestoreService(
        s.tenant_factory,
        s.connector,
        s.manifests,
        stub_owner_leases().leases,
      ),
  );
}

/** Restores one source event into the default calendar and returns the payload written to Graph. */
async function created_payload(
  source: GraphEventPayload,
): Promise<Readonly<Record<string, unknown>>> {
  const rig = restore_harness();
  save_snapshot(rig.manifests, [stored_event(rig.objects, 'src-default', source)]);
  await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });
  const created = rig.calls.created_events[0];
  if (created === undefined) throw new Error('no event was created');
  return created.payload;
}

const ALICE = {
  emailAddress: { name: 'Alice', address: 'alice@example.com' },
  type: 'required',
  status: { response: 'accepted' },
};
const OPS = {
  emailAddress: { name: 'Ops & Co', address: 'ops@example.com' },
  type: 'required',
  status: { response: 'accepted' },
};
const SUMMARY_HEADER = 'Restored by Atlas. Attendees were not re-invited.';

describe('restore event payload', () => {
  it('drops read-only, organizer-owned, and online-meeting fields', async () => {
    const payload = await created_payload(
      calendar_event('e-1', {
        createdDateTime: '2030-01-01T00:00:00Z',
        lastModifiedDateTime: '2030-01-02T00:00:00Z',
        changeKey: 'ck-1',
        webLink: 'https://outlook.example.com/item',
        bodyPreview: 'preview',
        hasAttachments: false,
        isCancelled: false,
        responseStatus: { response: 'organizer' },
        organizer: { emailAddress: { name: 'Dana', address: 'dana@example.com' } },
        attendees: [ALICE],
        isOnlineMeeting: true,
        onlineMeetingProvider: 'teamsForBusiness',
        onlineMeetingUrl: 'https://meet.example.com/x',
        '@odata.etag': 'W/"1"',
      }),
    );

    const dropped = [
      'id',
      'iCalUId',
      'createdDateTime',
      'lastModifiedDateTime',
      'changeKey',
      'webLink',
      'bodyPreview',
      'hasAttachments',
      'isCancelled',
      'responseStatus',
      'organizer',
      'attendees',
      'isOnlineMeeting',
      'onlineMeetingProvider',
      'onlineMeetingUrl',
      '@odata.etag',
    ];
    expect(dropped.filter((field) => field in payload)).toEqual([]);
  });

  it('keeps the writable fields and stamps the source event id', async () => {
    const payload = await created_payload(
      calendar_event('e-1', {
        subject: 'Design review',
        location: { displayName: 'Room 4' },
        showAs: 'busy',
      }),
    );

    expect(payload['subject']).toBe('Design review');
    expect(payload['location']).toEqual({ displayName: 'Room 4' });
    expect(payload['showAs']).toBe('busy');
    expect(payload['singleValueExtendedProperties']).toEqual([
      { id: SOURCE_TAG_ID, value: 'e-1' },
      { id: SOURCE_ICAL_UID_TAG_ID, value: 'uid-e-1' },
    ]);
  });

  it('prefixes a text body with the attendee summary', async () => {
    const payload = await created_payload(
      calendar_event('e-1', {
        attendees: [
          ALICE,
          {
            emailAddress: { name: 'Bob', address: 'bob@example.com' },
            type: 'optional',
            status: { response: 'none' },
          },
        ],
        body: { contentType: 'text', content: 'Agenda' },
      }),
    );

    expect(payload['body']).toEqual({
      contentType: 'text',
      content: `${SUMMARY_HEADER}\nAttendees: Alice <alice@example.com> (required, accepted); Bob <bob@example.com> (optional)\n\nAgenda`,
    });
  });

  it('names the organizer when another person organized the event', async () => {
    const payload = await created_payload(
      calendar_event('e-1', {
        isOrganizer: false,
        organizer: { emailAddress: { name: 'Carol', address: 'carol@example.com' } },
        attendees: [ALICE],
        body: { contentType: 'text', content: '' },
      }),
    );

    expect(payload['body']).toEqual({
      contentType: 'text',
      content: `${SUMMARY_HEADER}\nOrganizer: Carol <carol@example.com>\nAttendees: Alice <alice@example.com> (required, accepted)`,
    });
  });

  it('leaves the body of a solo event unchanged', async () => {
    const payload = await created_payload(
      calendar_event('e-1', { body: { contentType: 'text', content: 'Agenda' } }),
    );

    expect(payload['body']).toEqual({ contentType: 'text', content: 'Agenda' });
  });

  it('inserts an escaped summary block after the opening body tag of an html body', async () => {
    const payload = await created_payload(
      calendar_event('e-1', {
        attendees: [OPS],
        body: {
          contentType: 'html',
          content: '<html><body class="x"><p>Agenda & <b>notes</b></p></body></html>',
        },
      }),
    );

    expect(payload['body']).toEqual({
      contentType: 'html',
      content:
        '<html><body class="x"><p>Restored by Atlas. Attendees were not re-invited.<br>' +
        'Attendees: Ops &amp; Co &lt;ops@example.com&gt; (required, accepted)</p><hr>' +
        '<p>Agenda & <b>notes</b></p></body></html>',
    });
  });

  it('prepends the summary block to an html body without a body tag', async () => {
    const payload = await created_payload(
      calendar_event('e-1', {
        attendees: [OPS],
        body: { contentType: 'html', content: '<p>Agenda</p>' },
      }),
    );

    expect(payload['body']).toEqual({
      contentType: 'html',
      content:
        '<p>Restored by Atlas. Attendees were not re-invited.<br>' +
        'Attendees: Ops &amp; Co &lt;ops@example.com&gt; (required, accepted)</p><hr>' +
        '<p>Agenda</p>',
    });
  });
});
