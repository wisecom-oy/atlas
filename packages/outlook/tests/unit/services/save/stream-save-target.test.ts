import { readdirSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type {
  ManifestEntry,
  OperationControlOptions,
  TenantContext,
  TransferProgressReporter,
} from '@wisecom/atlas-types';
import { save_entries_to_archive } from '@/services/save/save-entry-processor';

/**
 * The stream export path with the real archive writer, not a mocked one: the point of issue #44
 * is that the bytes reach the caller and never the exporting machine's disk, and a mocked writer
 * cannot show either.
 */
const MIME_BLOB = Buffer.from(
  ['Message-ID: <original@partner.example>', 'Subject: Quarterly Review', '', 'Numbers.'].join(
    '\r\n',
  ),
  'utf-8',
);

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function make_entry(): ManifestEntry {
  return {
    object_id: 'msg-mime',
    storage_key: 'content/mime-blob',
    checksum: '',
    size_bytes: MIME_BLOB.length,
    subject: 'Quarterly Review',
    folder_id: 'f1',
    payload_format: 'mime',
    received_at: '2026-03-10T14:30:22Z',
  };
}

function make_context(): TenantContext {
  return {
    storage: { get: vi.fn().mockResolvedValue(MIME_BLOB) },
    decrypt: vi.fn((buf: Buffer) => buf),
    destroy: vi.fn(),
  } as unknown as TenantContext;
}

function make_dashboard(): TransferProgressReporter {
  return {
    mark_active: vi.fn(),
    update_active: vi.fn(),
    update_total: vi.fn(),
    mark_done: vi.fn(),
    mark_error: vi.fn(),
    mark_all_pending_interrupted: vi.fn(),
    show_finalizing: vi.fn(),
    finish: vi.fn(),
  } as unknown as TransferProgressReporter;
}

const control: OperationControlOptions = {};

describe('outlook save to a stream target', () => {
  it('writes a complete archive to the caller stream and no file (issue #44)', async () => {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (chunk: Buffer) => chunks.push(chunk));
    const before = readdirSync(process.cwd());

    const result = await save_entries_to_archive(
      make_context(),
      sink,
      '',
      true,
      new Map([['f1', [make_entry()]]]),
      new Map([['f1', 'Inbox']]),
      make_dashboard(),
      () => false,
      control,
    );

    const body = Buffer.concat(chunks);
    expect(body.subarray(0, 4)).toEqual(ZIP_MAGIC);
    expect(body.length).toBe(result.total_bytes);
    expect(result.saved_count).toBe(1);
    expect(result.integrity_failures).toEqual([]);
    // No path is reported, because there is no file: a caller that logged one would be lying.
    expect(result.output_path).toBe('');
    expect(readdirSync(process.cwd())).toEqual(before);
  });

  it('destroys the stream when the run fails, so a short archive is never a success', async () => {
    const sink = new PassThrough();
    const ctx = {
      storage: { get: vi.fn().mockRejectedValue(new Error('storage unavailable')) },
      decrypt: vi.fn(),
      destroy: vi.fn(),
    } as unknown as TenantContext;
    const dashboard = make_dashboard();
    vi.mocked(dashboard.show_finalizing).mockImplementation(() => {
      throw new Error('finalize failed');
    });

    await expect(
      save_entries_to_archive(
        ctx,
        sink,
        '',
        true,
        new Map([['f1', [make_entry()]]]),
        new Map([['f1', 'Inbox']]),
        dashboard,
        () => false,
        control,
      ),
    ).rejects.toThrow('finalize failed');

    expect(sink.destroyed).toBe(true);
    expect(sink.writableEnded).toBe(false);
  });
});
