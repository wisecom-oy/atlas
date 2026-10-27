import { describe, it, expect } from 'vitest';
import { parse_mime_message } from '@/services/shared/mime-message-parser';
import {
  build_restore_payload_from_mime,
  sanitize_message_for_restore,
} from '@/services/restore/restore-message-transformer';

const SET = '{41F28F13-83F4-4114-A584-EEDB5A6B0BFF}';
const REACTIONS = [
  { id: `String ${SET} Name OwnerReactionType`, value: 'like' },
  { id: `Binary ${SET} Name ReactionsSummary`, value: 'AAEC' },
];

const MIME = Buffer.from(
  [
    'From: "John Doe" <john.doe@example.com>',
    'To: "Jane Roe" <jane.roe@example.com>',
    'Subject: Example subject',
    'Date: Mon, 26 Oct 2026 10:00:00 +0000',
    'In-Reply-To: <root-1@example.com>',
    'Content-Type: text/plain; charset="utf-8"',
    '',
    'Body.',
    '',
  ].join('\r\n'),
);

const JSON_MESSAGE = {
  subject: 'Example subject',
  isRead: true,
  receivedDateTime: '2026-10-26T10:00:00Z',
  sentDateTime: '2026-10-26T09:59:00Z',
};

function property_ids(payload: Record<string, unknown>): string[] {
  return (payload['singleValueExtendedProperties'] as Array<{ id: string }>).map((p) => p.id);
}

describe('reaction properties on restore (issue #481)', () => {
  it('writes MIME-entry reactions alongside the overrides and threading properties', async () => {
    const payload = build_restore_payload_from_mime(await parse_mime_message(MIME), REACTIONS);

    expect(payload['singleValueExtendedProperties']).toEqual(expect.arrayContaining(REACTIONS));
    expect(property_ids(payload)).toEqual(
      expect.arrayContaining([
        'Integer 0x0E07',
        'SystemTime 0x0E06',
        'SystemTime 0x0039',
        'String 0x1042',
      ]),
    );
  });

  it('writes JSON-entry reactions alongside the read-state and timestamp overrides', () => {
    const payload = sanitize_message_for_restore(JSON_MESSAGE, REACTIONS);

    expect(payload['singleValueExtendedProperties']).toEqual([
      { id: 'Integer 0x0E07', value: '1' },
      { id: 'SystemTime 0x0E06', value: '2026-10-26T10:00:00Z' },
      { id: 'SystemTime 0x0039', value: '2026-10-26T09:59:00Z' },
      ...REACTIONS,
    ]);
  });

  it('restores an entry without reactions exactly as before', async () => {
    const parsed = await parse_mime_message(MIME);

    expect(build_restore_payload_from_mime(parsed, undefined)).toEqual(
      build_restore_payload_from_mime(parsed),
    );
    expect(sanitize_message_for_restore(JSON_MESSAGE, undefined)).toEqual(
      sanitize_message_for_restore(JSON_MESSAGE),
    );
    expect(property_ids(sanitize_message_for_restore(JSON_MESSAGE))).toHaveLength(3);
  });
});
