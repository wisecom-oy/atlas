import { describe, it, expect } from 'vitest';
import { build_eml, build_eml_filename, deduplicate_filename } from '@/services/save/eml-builder';

describe('build_eml', () => {
  const minimal_message: Record<string, unknown> = {
    subject: 'Test Subject',
    from: { emailAddress: { name: 'Alice', address: 'alice@example.com' } },
    toRecipients: [{ emailAddress: { name: 'Bob', address: 'bob@example.com' } }],
    body: { contentType: 'text', content: 'Hello world' },
    receivedDateTime: '2026-03-10T14:30:22Z',
    sentDateTime: '2026-03-10T14:30:00Z',
    internetMessageId: '<abc123@example.com>',
  };

  it('produces a buffer containing EML headers', () => {
    const result = build_eml(minimal_message, []);
    const text = result.toString('utf-8');

    expect(text).toContain('alice@example.com');
    expect(text).toContain('bob@example.com');
    expect(text).toContain('Subject:');
  });

  it('includes plain text body', () => {
    const result = build_eml(minimal_message, []);
    const text = result.toString('utf-8');
    expect(text).toContain('Hello world');
  });

  it('handles HTML body', () => {
    const msg = { ...minimal_message, body: { contentType: 'HTML', content: '<b>Bold</b>' } };
    const result = build_eml(msg, []);
    const text = result.toString('utf-8');
    expect(text).toContain('<b>Bold</b>');
  });

  it('includes attachments', () => {
    const attachment = {
      name: 'file.pdf',
      content_type: 'application/pdf',
      content: Buffer.from('pdf-content'),
      is_inline: false,
    };
    const result = build_eml(minimal_message, [attachment]);
    const text = result.toString('utf-8');
    expect(text).toContain('file.pdf');
  });

  it('sets Content-ID header on inline attachment with content_id', () => {
    const attachment = {
      name: 'logo.png',
      content_type: 'image/png',
      content: Buffer.from('png-data'),
      is_inline: true,
      content_id: 'image001.png@01DA3B2F.5A7E8990',
    };
    const result = build_eml(minimal_message, [attachment]);
    const text = result.toString('utf-8');
    expect(text).toContain('Content-ID');
    expect(text).toContain('image001.png@01DA3B2F.5A7E8990');
  });

  it('omits Content-ID header when inline attachment has no content_id', () => {
    const attachment = {
      name: 'icon.png',
      content_type: 'image/png',
      content: Buffer.from('png-data'),
      is_inline: true,
    };
    const result = build_eml(minimal_message, [attachment]);
    const text = result.toString('utf-8');
    expect(text).toContain('icon.png');
    expect(text).not.toContain('Content-ID');
  });

  it('handles message with no to-recipients gracefully', () => {
    const msg = {
      ...minimal_message,
      toRecipients: undefined,
    };
    const result = build_eml(msg as Record<string, unknown>, []);
    expect(result).toBeInstanceOf(Buffer);
    expect(result.toString('utf-8')).toContain('alice@example.com');
  });

  it('sets Date header from receivedDateTime', () => {
    const result = build_eml(minimal_message, []);
    const text = result.toString('utf-8');
    expect(text).toContain('Date:');
  });

  it('sets Message-ID header', () => {
    const result = build_eml(minimal_message, []);
    const text = result.toString('utf-8');
    expect(text).toContain('Message-ID');
  });

  it('handles message with empty body content', () => {
    const msg = { ...minimal_message, body: { contentType: 'text', content: '' } };
    const result = build_eml(msg, []);
    expect(result).toBeInstanceOf(Buffer);
    expect(result.toString('utf-8')).toContain('Subject:');
  });

  it('handles message with null body', () => {
    const msg = { ...minimal_message, body: null };
    const result = build_eml(msg as Record<string, unknown>, []);
    expect(result).toBeInstanceOf(Buffer);
    expect(result.toString('utf-8')).toContain('Subject:');
  });

  it('handles message with undefined body', () => {
    const msg = { ...minimal_message, body: undefined };
    const result = build_eml(msg as Record<string, unknown>, []);
    expect(result).toBeInstanceOf(Buffer);
  });

  it('handles message with body but no content property', () => {
    const msg = { ...minimal_message, body: { contentType: 'html' } };
    const result = build_eml(msg as Record<string, unknown>, []);
    expect(result).toBeInstanceOf(Buffer);
  });

  it('handles message with no from field', () => {
    const msg = { ...minimal_message, from: undefined };
    const result = build_eml(msg as Record<string, unknown>, []);
    expect(result).toBeInstanceOf(Buffer);
    expect(result.toString('utf-8')).toContain('unknown@localhost');
  });

  it('handles completely empty message', () => {
    const result = build_eml({}, []);
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBeGreaterThan(0);
  });

  it('handles cc and bcc recipients', () => {
    const msg = {
      ...minimal_message,
      ccRecipients: [{ emailAddress: { name: 'Carol', address: 'carol@example.com' } }],
      bccRecipients: [{ emailAddress: { name: 'Dave', address: 'dave@example.com' } }],
    };
    const result = build_eml(msg, []);
    const text = result.toString('utf-8');
    expect(text).toContain('carol@example.com');
    expect(text).toContain('dave@example.com');
  });
});

describe('build_eml_filename', () => {
  it('formats timestamp and subject correctly', () => {
    const result = build_eml_filename('2026-03-10T14:30:22Z', 'Meeting with client');
    expect(result).toBe('2026-03-10_143022_Meeting-with-client.eml');
  });

  it('uses "unknown" timestamp when date is undefined', () => {
    const result = build_eml_filename(undefined, 'Test');
    expect(result).toBe('unknown_Test.eml');
  });

  it('uses "no-subject" when subject is undefined', () => {
    const result = build_eml_filename('2026-03-10T14:30:22Z', undefined);
    expect(result).toBe('2026-03-10_143022_no-subject.eml');
  });

  it('sanitizes special characters from subject', () => {
    const result = build_eml_filename('2026-03-10T14:30:22Z', 'Re: Hello <World> / test');
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
    expect(result).not.toContain('/');
    expect(result).toMatch(/\.eml$/);
  });

  it('truncates long subjects to 80 characters', () => {
    const long_subject = 'A'.repeat(200);
    const result = build_eml_filename('2026-03-10T14:30:22Z', long_subject);
    const name_part = result.replace('2026-03-10_143022_', '').replace('.eml', '');
    expect(name_part.length).toBeLessThanOrEqual(80);
  });
});

describe('deduplicate_filename', () => {
  it('returns original name when no collision', () => {
    const used = new Set<string>();
    expect(deduplicate_filename('test.eml', used)).toBe('test.eml');
  });

  it('appends _1 on first collision', () => {
    const used = new Set(['test.eml']);
    expect(deduplicate_filename('test.eml', used)).toBe('test_1.eml');
  });

  it('increments suffix on repeated collisions', () => {
    const used = new Set(['test.eml', 'test_1.eml', 'test_2.eml']);
    expect(deduplicate_filename('test.eml', used)).toBe('test_3.eml');
  });

  it('adds used name to the set', () => {
    const used = new Set<string>();
    deduplicate_filename('a.eml', used);
    expect(used.has('a.eml')).toBe(true);
  });
});
