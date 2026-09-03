import { describe, expect, it } from 'vitest';
import { camelize, snakeize, type Camelize } from '@/public/case-convert';

describe('camelize', () => {
  it('renames nested keys and keeps values', () => {
    const internal = {
      snapshot_id: 'snap-1',
      summary: { attachments_stored: 3, folder_errors: ['Inbox'] },
      entries: [{ storage_key: 'k', size_bytes: 10 }],
    };

    expect(camelize(internal)).toEqual({
      snapshotId: 'snap-1',
      summary: { attachmentsStored: 3, folderErrors: ['Inbox'] },
      entries: [{ storageKey: 'k', sizeBytes: 10 }],
    });
  });

  it('leaves a Buffer as a Buffer', () => {
    const raw = Buffer.from('From: a@b\r\n\r\nbody');

    const converted = camelize({ raw, payload_format: 'mime' as const });

    // Descending into a Buffer turns a message body into { "0": 70, "1": 114, ... }.
    expect(Buffer.isBuffer(converted.raw)).toBe(true);
    expect(converted.raw.toString()).toBe('From: a@b\r\n\r\nbody');
    expect(converted.payloadFormat).toBe('mime');
  });

  it('leaves a Date as a Date', () => {
    const at = new Date('2026-03-01T00:00:00Z');

    const converted = camelize({ last_backup_at: at });

    expect(converted.lastBackupAt).toBeInstanceOf(Date);
    expect(converted.lastBackupAt.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('passes a raw Graph message payload through untouched', () => {
    const message = {
      '@odata.etag': 'W/"abc"',
      internetMessageHeaders: [{ name: 'X-Spam', value: '0' }],
      hasAttachments: false,
      body_preview_not_ours: 'vendor field',
    };

    const converted = camelize({ raw: Buffer.alloc(0), message, attachments: [] });

    // The payload is Microsoft's, not ours: renaming its keys would hand back a message that no
    // longer matches what Graph returned and what the blob contains.
    expect(converted.message).toEqual(message);
  });

  it('keeps data-derived record keys', () => {
    const internal = {
      delta_links: { 'AAMkAGE1M=': 'https://graph.microsoft.com/delta?token=x' },
      requests_by_type: { 'GET /messages/delta': 4 },
      by_service: { outlook: { request_count: 4 } },
    };

    const converted = camelize(internal);

    expect(Object.keys(converted.deltaLinks)).toEqual(['AAMkAGE1M=']);
    expect(Object.keys(converted.requestsByType)).toEqual(['GET /messages/delta']);
    // The pool name is an identifier that also appears in GRAPH_SERVICE_LIMITS, so it is kept
    // verbatim, while the cost object beneath it is ours and is converted.
    expect(converted.byService).toEqual({ outlook: { requestCount: 4 } });
  });

  it('passes functions and abort signals through', () => {
    const controller = new AbortController();
    const on_progress = (): void => undefined;

    const converted = camelize({ signal: controller.signal, on_progress });

    expect(converted.signal).toBe(controller.signal);
    expect(converted.onProgress).toBe(on_progress);
  });

  it('leaves an empty object and null alone', () => {
    expect(camelize({})).toEqual({});
    expect(camelize({ target_mailbox: null })).toEqual({ targetMailbox: null });
  });
});

describe('snakeize', () => {
  it('renames nested keys back', () => {
    expect(snakeize({ forceFull: true, objectLockRequest: { retentionDays: 7 } })).toEqual({
      force_full: true,
      object_lock_request: { retention_days: 7 },
    });
  });

  it('round-trips an internal shape', () => {
    const internal = {
      snapshot_id: 'snap-1',
      restored_count: 2,
      verification_warnings: [],
      restore_folder_name: 'Restore-2026',
    };

    expect(snakeize(camelize(internal))).toEqual(internal);
  });

  it('leaves an already-single-word key alone', () => {
    expect(snakeize({ fast: true, errors: ['x'] })).toEqual({ fast: true, errors: ['x'] });
  });
});

describe('Camelize', () => {
  it('describes the converted shape at the type level', () => {
    // Compile-time half of the contract: the runtime function and the mapped type have to agree,
    // and a mismatch here is a type error rather than a surprise at the call site.
    const converted: Camelize<{ snapshot_id: string; total_size_bytes: number }> = camelize({
      snapshot_id: 's',
      total_size_bytes: 1,
    });

    expect(converted.snapshotId).toBe('s');
    expect(converted.totalSizeBytes).toBe(1);
  });
});
