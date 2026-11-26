/**
 * Issue #892. A file whose final upload chunk ended ambiguously was reported as a plain failure,
 * and not at all when Ctrl+C was pressed while that chunk was in flight. Microsoft 365 may have
 * created the file, so it is named as possibly present, and a rerun under `--conflict rename`
 * would leave a second copy beside it.
 */
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { drive_chain_reads } from '@wisecom/atlas-types/testing/stub-drive-manifest-chain';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreateOutcomeUnknownError,
  UploadCommitUnknownError,
  type OneDriveConnector,
  type OneDriveManifestEntry,
  type OneDriveManifestRepository,
  type OneDriveSnapshotManifest,
  type TenantContext,
  type TenantContextFactory,
} from '@wisecom/atlas-types';
import { OneDriveRestoreService } from '@/services/restore/restore.service';
import { readable_manifests } from '@wisecom/atlas-types/testing/readable-listing';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

const CONTENT = Buffer.from('file-content');
const CHECKSUM = createHash('sha256').update(CONTENT).digest('hex');
const RANGE = 'bytes 10485760-10485859/10485860';

/**
 * An upload whose final chunk hangs until its 60 s deadline, then ends with an unknown outcome.
 * The service handles the error the same whichever upload path raised it.
 */
function final_chunk_timing_out(): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => {
      reject(new UploadCommitUnknownError({ range: RANGE, item: 'file' }, 'no answer within 60 s'));
    }, 60_000);
  });
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
  return new OneDriveRestoreService(factory, connector, manifests, stub_owner_leases().leases);
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

describe('OneDrive restore of a file whose final chunk ended ambiguously (issue #892)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('names the file as possibly present and fails the run as partial', async () => {
    const connector = make_connector({
      upload_small_file: vi.fn().mockImplementationOnce(final_chunk_timing_out),
    });
    const service = make_service(
      [make_entry('file-1', '/Docs'), make_entry('file-2', '/Docs')],
      connector,
    );

    const run = service.restore_onedrive('tenant-1', 'owner-1', { snapshot_id: 'snap-1' });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await run;

    expect(result.interrupted).toBe(false);
    expect(result.files_restored).toBe(1);
    expect(result.files_skipped).toBe(1);
    expect(result.errors).toEqual([
      `file-1.txt: outcome unknown, the file may exist: the final upload chunk (${RANGE}) ` +
        'ended with no answer within 60 s after Microsoft 365 may have committed it. ' +
        'Check the target before restoring it again',
    ]);
    // Issue #893: the file is also listed, with where it was being written.
    expect(result.outcome_unknown).toEqual([
      { path: expect.stringMatching(/\/Docs\/file-1\.txt$/), error: result.errors[0] },
    ]);
  });

  it('lists a single-request upload whose create outcome is unknown (issue #893)', async () => {
    const unknown = new CreateOutcomeUnknownError('HTTP 504');
    const connector = make_connector({
      upload_small_file: vi.fn().mockRejectedValueOnce(unknown).mockResolvedValue(undefined),
    });
    const service = make_service(
      [make_entry('file-1', '/Docs'), make_entry('file-2', '/Docs')],
      connector,
    );

    const result = await service.restore_onedrive('tenant-1', 'owner-1', { snapshot_id: 'snap-1' });

    expect(result.errors).toEqual([`file-1.txt: ${unknown.message}`]);
    expect(result.outcome_unknown).toEqual([
      { path: expect.stringMatching(/\/Docs\/file-1\.txt$/), error: result.errors[0] },
    ]);
  });

  it.each([400, 404, 409, 413])(
    'does not list a file Graph refused with %i (issue #893)',
    async (status) => {
      const refused = Object.assign(new Error(`HTTP ${status}`), { statusCode: status });
      const connector = make_connector({
        upload_small_file: vi.fn().mockRejectedValueOnce(refused).mockResolvedValue(undefined),
      });
      const service = make_service([make_entry('file-1', '/Docs')], connector);

      const result = await service.restore_onedrive('tenant-1', 'owner-1', {
        snapshot_id: 'snap-1',
      });

      expect(result.errors).toEqual([`file-1.txt: HTTP ${status}`]);
      expect(result.outcome_unknown).toEqual([]);
    },
  );

  it('names the file when Ctrl+C was pressed while its final chunk was in flight', async () => {
    const connector = make_connector({
      upload_small_file: vi.fn().mockImplementationOnce(final_chunk_timing_out),
    });
    const service = make_service(
      [make_entry('file-1', '/Docs'), make_entry('file-2', '/Docs')],
      connector,
    );
    const controller = new AbortController();

    const run = service.restore_onedrive('tenant-1', 'owner-1', {
      snapshot_id: 'snap-1',
      abort_signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(55_000);
    const result = await run;

    expect(result.interrupted).toBe(true);
    expect(result.files_restored).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^file-1\.txt: outcome unknown, the file may exist/);
    expect(result.outcome_unknown).toHaveLength(1);
    expect(connector.upload_small_file).toHaveBeenCalledTimes(1);
  });
});
