import { describe, it, expect } from 'vitest';
import { parse_mime_message } from '@/services/shared/mime-message-parser';
import { build_restore_payload_from_mime } from '@/services/restore/restore-message-transformer';

/** A sent item as Exchange exports it: Bcc kept, a Reply-To, a priority and categories. */
function sent_item(extra_headers: string[]): Buffer {
  return Buffer.from(
    [
      'From: "John Doe" <john.doe@example.com>',
      'To: "Jane Roe" <jane.roe@example.com>',
      ...extra_headers,
      'Subject: Example subject',
      'Date: Mon, 26 Oct 2026 10:00:00 +0000',
      'Message-ID: <root-1@example.com>',
      'Content-Type: text/plain; charset="utf-8"',
      '',
      'Body.',
      '',
    ].join('\r\n'),
    'utf-8',
  );
}

async function payload_for(extra_headers: string[]): Promise<Record<string, unknown>> {
  return build_restore_payload_from_mime(await parse_mime_message(sent_item(extra_headers)));
}

describe('build_restore_payload_from_mime', () => {
  it('restores Bcc recipients and Reply-To', async () => {
    const payload = await payload_for([
      'Bcc: "Audit" <audit@example.com>, hidden@example.com',
      'Reply-To: "Support" <support@example.com>',
    ]);

    expect(payload['bccRecipients']).toEqual([
      { emailAddress: { name: 'Audit', address: 'audit@example.com' } },
      { emailAddress: { name: '', address: 'hidden@example.com' } },
    ]);
    expect(payload['replyTo']).toEqual([
      { emailAddress: { name: 'Support', address: 'support@example.com' } },
    ]);
  });

  it('omits Bcc, Reply-To, importance and categories when the MIME carries none', async () => {
    const payload = await payload_for([]);

    expect(payload).not.toHaveProperty('bccRecipients');
    expect(payload).not.toHaveProperty('replyTo');
    expect(payload).not.toHaveProperty('importance');
    expect(payload).not.toHaveProperty('categories');
  });

  it.each([
    [['Importance: High'], 'high'],
    [['Importance: low'], 'low'],
    [['X-Priority: 1 (Highest)'], 'high'],
    [['X-Priority: 2'], 'high'],
    [['X-Priority: 3 (Normal)'], 'normal'],
    [['X-Priority: 5 (Lowest)'], 'low'],
    [['Importance: low', 'X-Priority: 1'], 'low'],
  ])('maps %j to importance %s', async (headers, expected) => {
    expect((await payload_for(headers))['importance']).toBe(expected);
  });

  it('ignores an unrecognised priority rather than guessing', async () => {
    const payload = await payload_for(['Importance: urgent', 'X-Priority: 9']);

    expect(payload).not.toHaveProperty('importance');
  });

  it('restores categories from the Keywords header', async () => {
    const payload = await payload_for(['Keywords: Red category, Project X,']);

    expect(payload['categories']).toEqual(['Red category', 'Project X']);
  });

  describe('conversation threading (issue #478)', () => {
    const props = (payload: Record<string, unknown>) =>
      payload['singleValueExtendedProperties'] as Array<{ id: string; value: string }>;

    it('writes In-Reply-To, References and Thread-Index as MAPI properties', async () => {
      const payload = await payload_for([
        'In-Reply-To: <parent-2@example.com>',
        'References: <root-0@example.com>',
        ' <parent-2@example.com>',
        'Thread-Index: AdtG3x9kQ2xVZ0pTRb2t8V1x3kF2Qw==',
      ]);

      expect(props(payload)).toEqual(
        expect.arrayContaining([
          { id: 'String 0x1042', value: '<parent-2@example.com>' },
          { id: 'String 0x1039', value: '<root-0@example.com> <parent-2@example.com>' },
          { id: 'Binary 0x0071', value: 'AdtG3x9kQ2xVZ0pTRb2t8V1x3kF2Qw==' },
        ]),
      );
    });

    it('keeps the read-state and timestamp overrides alongside them', async () => {
      const ids = props(await payload_for(['In-Reply-To: <p@example.com>'])).map((p) => p.id);

      expect(ids).toEqual([
        'Integer 0x0E07',
        'SystemTime 0x0E06',
        'SystemTime 0x0039',
        'String 0x1042',
      ]);
    });

    it('adds nothing for a message that starts a conversation', async () => {
      const ids = props(await payload_for([])).map((p) => p.id);

      expect(ids).toEqual(['Integer 0x0E07', 'SystemTime 0x0E06', 'SystemTime 0x0039']);
    });
  });
});
