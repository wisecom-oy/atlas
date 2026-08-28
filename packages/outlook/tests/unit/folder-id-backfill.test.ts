import { describe, expect, it, vi } from 'vitest';
import type { ManifestEntry, TenantContext } from '@wisecom/atlas-types';
import { backfill_missing_folder_ids } from '@/services/restore/restore-execution-orchestrator';
import { filter_entries_by_folder_name } from '@/services/restore/folder-restore-planner';

/**
 * Issue #205: the backfill decrypted every entry missing a `folder_id` and parsed it as JSON. An
 * entry stored with `payload_format: 'mime'` holds raw RFC 822 bytes, so the parse threw, and
 * because the backfill runs before any per-entry error handling the whole `-f` restore or export
 * died before touching a single message.
 */
const INBOX_ID = 'AAMkAG-inbox';

function entry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    object_id: 'msg-1',
    storage_key: 'outlook/data/owner/abc',
    checksum: 'sha',
    size_bytes: 10,
    ...overrides,
  } as ManifestEntry;
}

/** Context whose stored payload is whatever the test supplies, decrypted as-is. */
function make_ctx(payload_by_key: Record<string, string>): TenantContext {
  return {
    tenant_id: 't',
    storage: {
      get: vi.fn(async (key: string) => {
        const body = payload_by_key[key];
        if (body === undefined) throw new Error(`missing ${key}`);
        return Buffer.from(body, 'utf-8');
      }),
    },
    decrypt: (buf: Buffer) => buf,
  } as unknown as TenantContext;
}

const MIME_BODY = 'From: john.doe@example.com\r\nSubject: Example subject\r\n\r\nBody text\r\n';

describe('backfill_missing_folder_ids', () => {
  it('does not throw on a legacy MIME entry without folder_id', async () => {
    const mime = entry({ object_id: 'mime-1', storage_key: 'k-mime', payload_format: 'mime' });
    const ctx = make_ctx({ 'k-mime': MIME_BODY });

    await expect(backfill_missing_folder_ids(ctx, [mime])).resolves.toBeUndefined();
    expect(mime.folder_id).toBeUndefined();
  });

  it('still backfills a legacy JSON entry from its decrypted payload', async () => {
    const json = entry({ object_id: 'json-1', storage_key: 'k-json' });
    const ctx = make_ctx({ 'k-json': JSON.stringify({ parentFolderId: INBOX_ID }) });

    await backfill_missing_folder_ids(ctx, [json]);

    expect(json.folder_id).toBe(INBOX_ID);
  });

  it('backfills the JSON entries alongside a MIME entry that cannot be resolved', async () => {
    const mime = entry({ object_id: 'mime-1', storage_key: 'k-mime', payload_format: 'mime' });
    const json = entry({ object_id: 'json-1', storage_key: 'k-json' });
    const ctx = make_ctx({
      'k-mime': MIME_BODY,
      'k-json': JSON.stringify({ parentFolderId: INBOX_ID }),
    });

    await backfill_missing_folder_ids(ctx, [mime, json]);

    expect(json.folder_id).toBe(INBOX_ID);
    expect(mime.folder_id).toBeUndefined();
  });

  it('selects the folder-matching entries and skips the unresolved MIME one', async () => {
    // The end-to-end shape of a `-f Inbox` run: backfill, then filter.
    const mime = entry({ object_id: 'mime-1', storage_key: 'k-mime', payload_format: 'mime' });
    const json = entry({ object_id: 'json-1', storage_key: 'k-json' });
    const stamped = entry({ object_id: 'json-2', folder_id: INBOX_ID });
    const ctx = make_ctx({
      'k-mime': MIME_BODY,
      'k-json': JSON.stringify({ parentFolderId: INBOX_ID }),
    });
    const folder_map = new Map<string, string>([[INBOX_ID, 'Inbox']]);

    const entries = [mime, json, stamped];
    await backfill_missing_folder_ids(ctx, entries);
    const selected = filter_entries_by_folder_name(entries, 'Inbox', folder_map);

    expect(selected.map((e: ManifestEntry) => e.object_id)).toEqual(['json-1', 'json-2']);
  });

  it('does not decrypt anything when every entry already carries folder_id', async () => {
    const ctx = make_ctx({});
    const entries = [entry({ folder_id: INBOX_ID }), entry({ object_id: 'msg-2', folder_id: 'x' })];

    await backfill_missing_folder_ids(ctx, entries);

    expect(ctx.storage.get).not.toHaveBeenCalled();
  });

  it('keeps going when one JSON payload is unreadable', async () => {
    // A corrupt entry is the same failure shape as the MIME one: it must not take the run with it.
    const broken = entry({ object_id: 'json-broken', storage_key: 'k-broken' });
    const good = entry({ object_id: 'json-good', storage_key: 'k-good' });
    const ctx = make_ctx({
      'k-broken': 'not json at all',
      'k-good': JSON.stringify({ parentFolderId: INBOX_ID }),
    });

    await expect(backfill_missing_folder_ids(ctx, [broken, good])).resolves.toBeUndefined();

    expect(broken.folder_id).toBeUndefined();
    expect(good.folder_id).toBe(INBOX_ID);
  });
});
