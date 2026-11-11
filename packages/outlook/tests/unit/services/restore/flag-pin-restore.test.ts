import { describe, it, expect } from 'vitest';
import type { FollowUpFlag } from '@wisecom/atlas-types';
import { parse_mime_message } from '@/services/shared/mime-message-parser';
import {
  build_restore_payload_from_mime,
  sanitize_message_for_restore,
} from '@/services/restore/restore-message-transformer';

const COMPLETE: FollowUpFlag = {
  status: 'complete',
  completed: { date_time: '2026-11-05T00:00:00.0000000', time_zone: 'UTC' },
};
const FLAGGED: FollowUpFlag = {
  status: 'flagged',
  start: { date_time: '2026-11-10T00:00:00.0000000', time_zone: 'UTC' },
  due: { date_time: '2026-11-20T00:00:00.0000000', time_zone: 'UTC' },
};
const PIN = [
  { id: 'SystemTime 0x0F02', value: '4500-09-01T00:00:00Z' },
  { id: 'SystemTime 0x0F01', value: '4500-09-01T00:00:00Z' },
];

const MIME = Buffer.from(
  [
    'From: "John Doe" <john.doe@example.com>',
    'To: "Jane Roe" <jane.roe@example.com>',
    'Subject: Example subject',
    'Date: Mon, 26 Oct 2026 10:00:00 +0000',
    'X-Message-Flag: Flag for follow up',
    'Content-Type: text/plain; charset="utf-8"',
    '',
    'Body.',
    '',
  ].join('\r\n'),
);

/** Issue #579: every MIME-backed message came back `notFlagged` and unpinned. */
describe('flag and pin on restore', () => {
  it('writes the recorded flag with its dates and the pin on a MIME entry', async () => {
    const payload = build_restore_payload_from_mime(await parse_mime_message(MIME), {
      flag: FLAGGED,
      pin_properties: PIN,
    });

    expect(payload['flag']).toEqual({
      flagStatus: 'flagged',
      startDateTime: { dateTime: '2026-11-10T00:00:00.0000000', timeZone: 'UTC' },
      dueDateTime: { dateTime: '2026-11-20T00:00:00.0000000', timeZone: 'UTC' },
    });
    expect(payload['singleValueExtendedProperties']).toEqual(expect.arrayContaining(PIN));
  });

  it('writes a completed flag with its completion date', async () => {
    const payload = build_restore_payload_from_mime(await parse_mime_message(MIME), {
      flag: COMPLETE,
    });

    expect(payload['flag']).toEqual({
      flagStatus: 'complete',
      completedDateTime: { dateTime: '2026-11-05T00:00:00.0000000', timeZone: 'UTC' },
    });
  });

  it('restores an entry written before the fields unflagged and unpinned', async () => {
    const payload = build_restore_payload_from_mime(await parse_mime_message(MIME), {});
    const ids = (payload['singleValueExtendedProperties'] as Array<{ id: string }>).map(
      (p) => p.id,
    );

    expect(payload).not.toHaveProperty('flag');
    expect(ids).not.toContain('SystemTime 0x0F02');
  });

  it('keeps the flag of a JSON payload and adds the recorded pin', () => {
    const graph_flag = { flagStatus: 'flagged' };
    const payload = sanitize_message_for_restore(
      { subject: 'Example subject', flag: graph_flag },
      { flag: COMPLETE, pin_properties: PIN },
    );

    expect(payload['flag']).toBe(graph_flag);
    expect(payload['singleValueExtendedProperties']).toEqual(expect.arrayContaining(PIN));
  });

  it('fills a JSON payload without a flag from the recorded one', () => {
    const payload = sanitize_message_for_restore(
      { subject: 'Example subject' },
      { flag: COMPLETE },
    );

    expect(payload['flag']).toMatchObject({ flagStatus: 'complete' });
  });
});
