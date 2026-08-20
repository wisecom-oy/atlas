import { describe, it, expect } from 'vitest';
import { parse_mime_message } from '@/services/shared/mime-message-parser';

const ATTACHMENT_BYTES = Buffer.from('Atlas,MIME,restore\n1,2,3\n', 'utf-8');

/**
 * Realistic Graph /$value output: multipart/mixed wrapping a text+html
 * alternative and a base64 attachment, with a two-hop Received chain,
 * Authentication-Results and threading headers.
 */
function build_mime_fixture(): Buffer {
  return Buffer.from(
    [
      'Received: from EXCH02.corp.example.com (10.0.0.12) by',
      '\tMAIL01.corp.example.com (10.0.0.5) with Microsoft SMTP Server id',
      '\t15.20.6455.021; Tue, 4 Mar 2025 09:15:04 +0000',
      'Received: from smtp.partner.example (smtp.partner.example [203.0.113.9]) by',
      '\tEXCH02.corp.example.com with ESMTPS id 4fk2m9; Tue, 4 Mar 2025 09:15:01 +0000',
      'Authentication-Results: spf=pass (sender IP is 203.0.113.9)',
      '\tsmtp.mailfrom=partner.example; dkim=pass header.d=partner.example',
      'From: "Nora Partner" <nora@partner.example>',
      'To: "Atlas Admin" <admin@corp.example.com>, ops@corp.example.com',
      'Cc: "Audit Log" <audit@corp.example.com>',
      'Subject: Q1 reconciliation figures',
      'Date: Tue, 4 Mar 2025 09:14:58 +0000',
      'Message-ID: <thread-root-9f21@partner.example>',
      'In-Reply-To: <prior-msg-7a01@corp.example.com>',
      'References: <prior-msg-7a01@corp.example.com> <older-5b02@corp.example.com>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="OUTER"',
      '',
      '--OUTER',
      'Content-Type: multipart/alternative; boundary="INNER"',
      '',
      '--INNER',
      'Content-Type: text/plain; charset="utf-8"',
      '',
      'Figures attached.',
      '',
      '--INNER',
      'Content-Type: text/html; charset="utf-8"',
      '',
      '<html><body><p>Figures attached.</p></body></html>',
      '',
      '--INNER--',
      '',
      '--OUTER',
      'Content-Type: text/csv; name="q1.csv"',
      'Content-Disposition: attachment; filename="q1.csv"',
      'Content-Transfer-Encoding: base64',
      '',
      ATTACHMENT_BYTES.toString('base64'),
      '',
      '--OUTER--',
      '',
    ].join('\r\n'),
    'utf-8',
  );
}

describe('parse_mime_message', () => {
  it('extracts subject, addresses and ISO date', async () => {
    const parsed = await parse_mime_message(build_mime_fixture());

    expect(parsed.subject).toBe('Q1 reconciliation figures');
    expect(parsed.from).toEqual({ name: 'Nora Partner', address: 'nora@partner.example' });
    expect(parsed.to).toEqual([
      { name: 'Atlas Admin', address: 'admin@corp.example.com' },
      { name: '', address: 'ops@corp.example.com' },
    ]);
    expect(parsed.cc).toEqual([{ name: 'Audit Log', address: 'audit@corp.example.com' }]);
    expect(parsed.date).toBe('2025-03-04T09:14:58.000Z');
    expect(parsed.message_id).toBe('<thread-root-9f21@partner.example>');
  });

  it('decodes both body alternatives', async () => {
    const parsed = await parse_mime_message(build_mime_fixture());

    expect(parsed.html).toContain('<p>Figures attached.</p>');
    expect(parsed.text?.trim()).toBe('Figures attached.');
  });

  it('preserves every Received hop and the threading headers', async () => {
    const parsed = await parse_mime_message(build_mime_fixture());
    const received = parsed.headers.filter((h) => h.name.toLowerCase() === 'received');

    expect(received).toHaveLength(2);
    expect(received[0]?.value).toContain('EXCH02.corp.example.com');
    expect(received[1]?.value).toContain('smtp.partner.example');

    const names = parsed.headers.map((h) => h.name.toLowerCase());
    expect(names).toContain('authentication-results');
    expect(names).toContain('references');
    expect(names).toContain('in-reply-to');

    const references = parsed.headers.find((h) => h.name.toLowerCase() === 'references');
    expect(references?.value).toContain('<older-5b02@corp.example.com>');
  });

  it('unfolds multi-line header values into one string', async () => {
    const parsed = await parse_mime_message(build_mime_fixture());
    const auth = parsed.headers.find((h) => h.name.toLowerCase() === 'authentication-results');

    expect(auth?.value).toBe(
      'spf=pass (sender IP is 203.0.113.9) smtp.mailfrom=partner.example; dkim=pass header.d=partner.example',
    );
  });

  it('returns the attachment with exact decoded bytes', async () => {
    const parsed = await parse_mime_message(build_mime_fixture());

    expect(parsed.attachments).toHaveLength(1);
    const att = parsed.attachments[0];
    expect(att?.name).toBe('q1.csv');
    expect(att?.content_type).toBe('text/csv');
    expect(att?.is_inline).toBe(false);
    expect(att?.content.equals(ATTACHMENT_BYTES)).toBe(true);
  });

  it('marks a cid attachment as inline and strips the angle brackets', async () => {
    const mime = Buffer.from(
      [
        'From: sender@example.com',
        'Subject: inline logo',
        'MIME-Version: 1.0',
        'Content-Type: multipart/related; boundary="REL"',
        '',
        '--REL',
        'Content-Type: text/html',
        '',
        '<img src="cid:logo-1@example.com">',
        '',
        '--REL',
        'Content-Type: image/png',
        'Content-Disposition: inline',
        'Content-ID: <logo-1@example.com>',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
        '',
        '--REL--',
        '',
      ].join('\r\n'),
      'utf-8',
    );

    const parsed = await parse_mime_message(mime);

    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.is_inline).toBe(true);
    expect(parsed.attachments[0]?.content_id).toBe('logo-1@example.com');
  });

  it('tolerates a bare message with no body parts or addresses', async () => {
    const parsed = await parse_mime_message(Buffer.from('Subject: ping\r\n\r\n', 'utf-8'));

    expect(parsed.subject).toBe('ping');
    expect(parsed.from).toBeUndefined();
    expect(parsed.to).toEqual([]);
    expect(parsed.cc).toEqual([]);
    expect(parsed.attachments).toEqual([]);
  });
});
