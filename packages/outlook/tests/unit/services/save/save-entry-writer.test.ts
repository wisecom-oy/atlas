import { describe, it, expect, vi, beforeEach } from 'vitest';
import { save_json_entry } from '@/services/save/save-entry-writer';
import type { EntryResult } from '@/services/save/save-entry-writer';
import type { SaveArchive } from '@/services/save/save-zip-writer';
import type { AttachmentEntry, ManifestEntry, TenantContext } from '@wisecom/atlas-types';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';

interface AppendedEml {
  folder: string;
  filename: string;
  content: Buffer;
}

const { appended } = vi.hoisted(() => ({ appended: [] as AppendedEml[] }));

vi.mock('@/services/save/save-zip-writer', () => ({
  add_eml_to_archive: vi.fn(
    (_archive: unknown, folder: string, filename: string, content: Buffer) => {
      appended.push({ folder, filename, content });
      return Promise.resolve();
    },
  ),
}));

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

function make_attachment(
  attachment_id: string,
  name: string,
  storage_key: string,
  overrides: Partial<AttachmentEntry> = {},
): AttachmentEntry {
  return {
    attachment_id,
    name,
    content_type: 'application/octet-stream',
    size_bytes: 12,
    storage_key,
    checksum: '',
    is_inline: false,
    ...overrides,
  };
}

function make_entry(attachments: AttachmentEntry[]): ManifestEntry {
  return {
    object_id: 'msg-json',
    storage_key: 'content/json-blob',
    checksum: '',
    size_bytes: JSON_BLOB.length,
    subject: 'Legacy Report',
    folder_id: 'f1',
    attachments,
  };
}

/** Context whose storage serves `blobs`; keys in `undecryptable` fail decryption like a bad auth tag. */
function make_context(
  blobs: Record<string, Buffer>,
  undecryptable: ReadonlySet<string> = new Set(),
): TenantContext {
  const { ctx } = stub_tenant_context(blobs);
  vi.spyOn(ctx.storage, 'get');
  vi.spyOn(ctx, 'decrypt').mockImplementation((buf: Buffer, key: string) => {
    if (undecryptable.has(key)) throw new Error('Unsupported state or unable to authenticate data');
    return buf;
  });
  return ctx;
}

async function write_entry(
  ctx: TenantContext,
  entry: ManifestEntry,
  skip_integrity = false,
): Promise<EntryResult> {
  const result: EntryResult = {
    attachment_count: 0,
    integrity_ok: 0,
    integrity_fail: 0,
    integrity_failures: [],
  };
  await save_json_entry(
    ctx,
    entry,
    'Inbox',
    JSON_BLOB,
    skip_integrity,
    {} as SaveArchive,
    new Set(),
    result,
  );
  return result;
}

describe('save_json_entry attachment failures', () => {
  beforeEach(() => {
    appended.length = 0;
  });

  it('records the one attachment that fails to decrypt and still writes the rest of the message', async () => {
    const ctx = make_context(
      { 'content/ok': Buffer.from('ok-bytes'), 'content/broken': Buffer.from('x') },
      new Set(['content/broken']),
    );
    const entry = make_entry([
      make_attachment('att-ok', 'good.txt', 'content/ok'),
      make_attachment('att-bad', 'bad.txt', 'content/broken'),
    ]);

    const result = await write_entry(ctx, entry);

    expect(result.integrity_failures).toEqual(['message:msg-json attachment:att-bad']);
    expect(result.integrity_fail).toBe(1);
    expect(result.attachment_count).toBe(1);
    expect(appended).toHaveLength(1);

    const eml = appended[0]!.content.toString('utf-8');
    expect(eml).toContain('filename="good.txt"');
    expect(eml).not.toContain('bad.txt');
  });

  it('records an attachment that has a size but no stored key', async () => {
    const ctx = make_context({});
    const entry = make_entry([make_attachment('att-lost', 'lost.txt', '', { size_bytes: 12 })]);

    const result = await write_entry(ctx, entry);

    expect(result.integrity_failures).toEqual(['message:msg-json attachment:att-lost']);
    expect(result.attachment_count).toBe(0);
    expect(ctx.storage.get).not.toHaveBeenCalled();
  });

  it('does not flag a zero-byte attachment that has no stored key', async () => {
    const ctx = make_context({});
    const entry = make_entry([make_attachment('att-empty', 'empty.txt', '', { size_bytes: 0 })]);

    const result = await write_entry(ctx, entry);

    expect(result.integrity_failures).toEqual([]);
    expect(result.integrity_fail).toBe(0);
  });

  it('names the message and attachment when a checksum does not match', async () => {
    const ctx = make_context({ 'content/ok': Buffer.from('ok-bytes') });
    const entry = make_entry([
      make_attachment('att-ok', 'good.txt', 'content/ok', { checksum: 'deadbeef' }),
    ]);

    const result = await write_entry(ctx, entry);

    expect(result.integrity_failures).toEqual(['message:msg-json attachment:att-ok']);
    expect(result.integrity_fail).toBe(1);
  });

  it('skips checksum comparison when integrity checks are skipped', async () => {
    const ctx = make_context({ 'content/ok': Buffer.from('ok-bytes') });
    const entry = make_entry([
      make_attachment('att-ok', 'good.txt', 'content/ok', { checksum: 'deadbeef' }),
    ]);

    const result = await write_entry(ctx, entry, true);

    expect(result.integrity_failures).toEqual([]);
    expect(result.attachment_count).toBe(1);
  });
});
