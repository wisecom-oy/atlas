/**
 * Issue #682. The OneDrive restore read its interrupt flag only between files and never ran under
 * the abort signal, so Ctrl+C during a Graph call parked in a Retry-After sat the wait out. A
 * call cut short by the signal is the run stopping, not a skipped file.
 */
import { drive_chain_reads } from '@wisecom/atlas-types/testing/stub-drive-manifest-chain';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import type {
  OneDriveConnector,
  OneDriveManifestEntry,
  OneDriveManifestRepository,
  OneDriveRestoreResult,
  OneDriveSnapshotManifest,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { OneDriveRestoreService } from '@/services/restore/restore.service';
import { readable_manifests } from '@wisecom/atlas-types/testing/readable-listing';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

const CONTENT = Buffer.from('file-content');
const CHECKSUM = createHash('sha256').update(CONTENT).digest('hex');

/** A Graph call throttled with `Retry-After: 360`, which on its own waits six minutes. */
function graph_call_parked_in_retry_wait(): Promise<never> {
  return with_graph_retry(() =>
    Promise.reject({
      statusCode: 429,
      message: 'Too Many Requests',
      headers: new Headers({ 'retry-after': '360' }),
    }),
  );
}

function make_entry(file_id: string, parent_path: string): OneDriveManifestEntry {
  return {
    file_id,
    drive_id: 'drive-a',
    file_name: `${file_id}.txt`,
    parent_path,
    size_bytes: CONTENT.length,
    change_type: 'updated',
    backup_at: '2026-08-17T00:00:00.000Z',
    storage_key: `onedrive/data/${file_id}`,
    checksum: CHECKSUM,
  } as OneDriveManifestEntry;
}

function make_service(entries: OneDriveManifestEntry[], connector: OneDriveConnector) {
  const ctx = {
    storage: { get: vi.fn().mockResolvedValue(CONTENT) },
    decrypt: vi.fn((data: Buffer) => data),
    destroy: vi.fn(),
  } as unknown as TenantContext;
  const factory = {
    create_readonly: vi.fn().mockResolvedValue(ctx),
  } as unknown as TenantContextFactory;
  const manifests = {
    find_by_snapshot: vi.fn().mockResolvedValue({
      snapshot_id: 'snap-1',
      owner_id: 'owner-1',
      created_at: new Date('2026-08-17T00:00:00.000Z'),
      entries,
    } as unknown as OneDriveSnapshotManifest),
    list_readable_snapshots_by_owner: vi.fn().mockResolvedValue(readable_manifests([])),
    ...drive_chain_reads('onedrive'),
  } as unknown as OneDriveManifestRepository;
  return new OneDriveRestoreService(factory, connector, manifests);
}

function make_connector(overrides: Partial<Record<keyof OneDriveConnector, unknown>>) {
  return {
    list_drives: vi.fn().mockResolvedValue([{ drive_id: 'drive-a', drive_name: 'OneDrive' }]),
    create_folder: vi.fn().mockResolvedValue('folder-1'),
    upload_small_file: vi.fn().mockResolvedValue(undefined),
    upload_large_file: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as OneDriveConnector;
}

/** Starts a restore, aborts it 5 s in, and returns its result once the abort has had 1 s. */
async function restore_cancelled_after_five_seconds(
  service: OneDriveRestoreService,
): Promise<OneDriveRestoreResult> {
  const controller = new AbortController();
  let settled = false;
  const run = service
    .restore_onedrive('tenant-1', 'owner-1', {
      snapshot_id: 'snap-1',
      abort_signal: controller.signal,
    })
    .finally(() => (settled = true));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(settled).toBe(false);

  controller.abort(new Error('Run interrupted by Ctrl+C'));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(settled).toBe(true);
  return run;
}

describe('OneDrive restore cancelled during a Graph retry wait (issue #682)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ends an upload wait within a second and reports the files already restored', async () => {
    const connector = make_connector({
      upload_small_file: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementation(graph_call_parked_in_retry_wait),
    });
    const service = make_service(
      [make_entry('file-1', '/Docs'), make_entry('file-2', '/Docs'), make_entry('file-3', '/Docs')],
      connector,
    );

    const result = await restore_cancelled_after_five_seconds(service);

    expect(result.interrupted).toBe(true);
    expect(result.files_restored).toBe(1);
    expect(result.files_skipped).toBe(0);
    expect(result.errors).toEqual([]);
    expect(connector.upload_small_file).toHaveBeenCalledTimes(2);
  });

  it('does not report a folder create cut short by the signal as an uncreatable path', async () => {
    const connector = make_connector({
      create_folder: vi.fn().mockImplementation(graph_call_parked_in_retry_wait),
    });
    const service = make_service([make_entry('file-1', '/Docs')], connector);

    const result = await restore_cancelled_after_five_seconds(service);

    expect(result.interrupted).toBe(true);
    expect(result.files_skipped).toBe(0);
    expect(result.errors).toEqual([]);
    expect(connector.upload_small_file).not.toHaveBeenCalled();
  });
});
