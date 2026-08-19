import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { save_entries_to_archive } from '@/services/save/save-entry-processor';
import type { AttachmentEntry, ManifestEntry } from '@wisecom/atlas-types';
import type { TenantContext } from '@wisecom/atlas-types';
import type { OperationControlOptions, TransferProgressReporter } from '@wisecom/atlas-types';

interface AppendedEml {
  folder: string;
  filename: string;
  content: Buffer;
}

const { appended } = vi.hoisted(() => ({ appended: [] as AppendedEml[] }));

vi.mock('@/services/save/save-zip-writer', () => ({
  create_save_archive: vi.fn(() => ({ archive: {}, promise: Promise.resolve(2048) })),
  add_eml_to_archive: vi.fn(
    (_archive: unknown, folder: string, filename: string, content: Buffer) => {
      appended.push({ folder, filename, content });
      return Promise.resolve();
    },
  ),
  finalize_archive: vi.fn(() => Promise.resolve()),
}));

const MIME_BLOB = Buffer.from(
  [
    'Received: from mail.partner.example (mail.partner.example [203.0.113.9])',
    ' by outlook.office365.com with ESMTPS; Tue, 10 Mar 2026 14:30:22 +0000',
    'Authentication-Results: spf=pass smtp.mailfrom=partner.example; dkim=pass',
    'DKIM-Signature: v=1; a=rsa-sha256; d=partner.example; s=sel; b=AbC123',
    'References: <thread-root@partner.example>',
    ' <reply-1@partner.example>',
    'In-Reply-To: <reply-1@partner.example>',
    'Message-ID: <original@partner.example>',
    'Subject: Quarterly Review',
    'Content-Type: text/plain; charset="utf-8"',
    '',
    'Numbers attached.',
    '',
  ].join('\r\n'),
  'utf-8',
);

const JSON_BLOB = Buffer.from(
  JSON.stringify({
    subject: 'Legacy Report',
    receivedDateTime: '2026-03-11T09:05:00Z',
    from: { emailAddress: { name: 'Ann', address: 'ann@example.com' } },
    toRecipients: [{ emailAddress: { name: 'Bob', address: 'bob@example.com' } }],
    body: { contentType: 'text', content: 'Legacy body' },
  }),
  'utf-8',
);

function make_attachment(storage_key: string): AttachmentEntry {
  return {
    attachment_id: 'att-1',
    name: 'numbers.xlsx',
    content_type: 'application/vnd.ms-excel',
    size_bytes: 12,
    storage_key,
    checksum: '',
    is_inline: false,
  };
}

function make_mime_entry(): ManifestEntry {
  return {
    object_id: 'msg-mime',
    storage_key: 'content/mime-blob',
    checksum: '',
    size_bytes: MIME_BLOB.length,
    subject: 'Quarterly Review',
    folder_id: 'f1',
    payload_format: 'mime',
    received_at: '2026-03-10T14:30:22Z',
    // Present on purpose: a MIME entry must never read attachment blobs even
    // if a manifest carries them, because the MIME already embeds them.
    attachments: [make_attachment('content/should-never-be-read')],
  };
}

function make_json_entry(): ManifestEntry {
  return {
    object_id: 'msg-json',
    storage_key: 'content/json-blob',
    checksum: '',
    size_bytes: JSON_BLOB.length,
    subject: 'Legacy Report',
    folder_id: 'f1',
    attachments: [make_attachment('content/json-attachment')],
  };
}

describe('save archive payload_format routing', () => {
  let ctx: TenantContext;
  let dashboard: TransferProgressReporter;
  const control: OperationControlOptions = {};

  beforeEach(() => {
    appended.length = 0;

    const blobs: Record<string, Buffer> = {
      'content/mime-blob': MIME_BLOB,
      'content/json-blob': JSON_BLOB,
      'content/json-attachment': Buffer.from('attachment-bytes'),
      'content/should-never-be-read': Buffer.from('boom'),
    };

    ctx = {
      storage: {
        get: vi.fn((key: string) => Promise.resolve(blobs[key] ?? Buffer.alloc(0))),
        put: vi.fn(),
        exists: vi.fn(),
        delete: vi.fn(),
      },
      decrypt: vi.fn((buf: Buffer) => buf),
      encrypt: vi.fn((buf: Buffer) => buf),
      destroy: vi.fn(),
    } as unknown as TenantContext;

    dashboard = {
      mark_active: vi.fn(),
      update_active: vi.fn(),
      mark_done: vi.fn(),
      mark_all_pending_interrupted: vi.fn(),
      mark_error: vi.fn(),
      update_total: vi.fn(),
      show_finalizing: vi.fn(),
      finish: vi.fn(),
    };
  });

  async function run(entries: ManifestEntry[]): Promise<void> {
    await save_entries_to_archive(
      ctx,
      'out.zip',
      false,
      new Map([['f1', entries]]),
      new Map([['f1', 'Inbox']]),
      dashboard,
      () => false,
      control,
    );
  }

  it('writes a MIME entry into the archive byte-identical to the decrypted blob', async () => {
    await run([make_mime_entry()]);

    expect(appended).toHaveLength(1);
    expect(Buffer.compare(appended[0]!.content, MIME_BLOB)).toBe(0);

    const written = appended[0]!.content.toString('utf-8');
    expect(written).toContain('Received: from mail.partner.example');
    expect(written).toContain('Authentication-Results: spf=pass');
    expect(written).toContain('DKIM-Signature: v=1;');
    expect(written).toContain(
      'References: <thread-root@partner.example>\r\n <reply-1@partner.example>',
    );
  });

  it('does not read attachment blobs for a MIME entry', async () => {
    await run([make_mime_entry()]);

    const get = ctx.storage.get as Mock;
    expect(get.mock.calls.map((c) => c[0])).toEqual(['content/mime-blob']);
  });

  it('names the MIME .eml from received_at and subject', async () => {
    await run([make_mime_entry()]);

    expect(appended[0]!.filename).toBe('2026-03-10_143022_Quarterly-Review.eml');
    expect(appended[0]!.folder).toBe('Inbox');
  });

  it('still rebuilds a legacy JSON entry through build_eml with its attachments', async () => {
    const result_count = await save_entries_to_archive(
      ctx,
      'out.zip',
      false,
      new Map([['f1', [make_json_entry()]]]),
      new Map([['f1', 'Inbox']]),
      dashboard,
      () => false,
      control,
    );

    expect(result_count.attachment_count).toBe(1);
    expect(appended).toHaveLength(1);
    expect(appended[0]!.filename).toBe('2026-03-11_090500_Legacy-Report.eml');

    const eml = appended[0]!.content.toString('utf-8');
    expect(eml).toContain('MIME-Version: 1.0');
    expect(eml).toContain('Content-Type: multipart/mixed;');
    expect(eml).toContain('Date: Wed, 11 Mar 2026 09:05:00 GMT');
    expect(eml).toContain('Subject: =?utf-8?B?TGVnYWN5IFJlcG9ydA==?=');
    expect(eml).toContain('<bob@example.com>');
    expect(eml).toContain('filename="numbers.xlsx"');
    expect(eml).toContain(Buffer.from('attachment-bytes').toString('base64'));
    expect(eml).not.toContain('receivedDateTime');

    const get = ctx.storage.get as Mock;
    expect(get.mock.calls.map((c) => c[0])).toEqual([
      'content/json-blob',
      'content/json-attachment',
    ]);
  });
});
