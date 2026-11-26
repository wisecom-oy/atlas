/**
 * Issue #892. A file whose final upload chunk ended ambiguously was reported as a plain failure,
 * and not at all when Ctrl+C was pressed while that chunk was in flight. Microsoft 365 may have
 * created the file, so it is named as possibly present, as OneDrive does.
 */
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { drive_chain_reads } from '@wisecom/atlas-types/testing/stub-drive-manifest-chain';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreateOutcomeUnknownError,
  UploadCommitUnknownError,
  type SharePointManifestEntry,
  type SharePointManifestRepository,
  type SharePointSiteConnector,
  type TenantContextFactory,
} from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { SharePointRestoreService } from '@/services/restore/restore.service';
import { readable_manifests } from '@wisecom/atlas-types/testing/readable-listing';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

const CONTENT = Buffer.from('restored-file-content');
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

function make_entry(file_id: string): SharePointManifestEntry {
  return {
    file_id,
    drive_id: 'drive-1',
    library_name: 'Documents',
    file_name: `${file_id}.docx`,
    parent_path: '/Reports',
    size_bytes: CONTENT.length,
    change_type: 'created',
    backup_at: '2026-08-17T00:00:00.000Z',
    storage_key: `sharepoint/data/site-1/${file_id}`,
    checksum: CHECKSUM,
  };
}

function make_harness(first_upload: () => Promise<never> = final_chunk_timing_out) {
  const entries = [make_entry('file-1'), make_entry('file-2'), make_entry('file-3')];
  const store = in_memory_tenant_context('tenant-1');
  for (const entry of entries) {
    store.set_raw(entry.storage_key!, store.ctx.encrypt(CONTENT, entry.storage_key!));
  }
  const factory = {
    create_readonly: vi.fn().mockResolvedValue(store.ctx),
  } as unknown as TenantContextFactory;
  const connector = {
    list_document_libraries: vi.fn().mockResolvedValue([]),
    create_folder: vi.fn().mockResolvedValue('folder-1'),
    upload_small_file: vi.fn().mockImplementationOnce(first_upload).mockResolvedValue(undefined),
    upload_large_file: vi.fn().mockResolvedValue(undefined),
  } as unknown as SharePointSiteConnector;
  const manifests = {
    find_by_snapshot: vi.fn().mockResolvedValue({
      snapshot_id: 'sp-snap-1',
      site_id: 'site-1',
      created_at: new Date('2026-08-17T00:00:00.000Z'),
      total_files: entries.length,
      entries,
    }),
    list_readable_snapshots_by_site: vi.fn().mockResolvedValue(readable_manifests([])),
    ...drive_chain_reads('sharepoint'),
  } as unknown as SharePointManifestRepository;
  return {
    connector,
    service: new SharePointRestoreService(
      factory,
      connector,
      manifests,
      stub_owner_leases().leases,
    ),
  };
}

describe('SharePoint restore of a file whose final chunk ended ambiguously (issue #892)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('names the file as possibly present and fails the run as partial', async () => {
    const { service } = make_harness();

    const run = service.restore_sharepoint('tenant-1', 'site-1', { snapshot_id: 'sp-snap-1' });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await run;

    expect(result.interrupted).toBe(false);
    expect(result.files_restored).toBe(2);
    expect(result.files_skipped).toBe(1);
    expect(result.errors).toEqual([
      `file-1.docx: outcome unknown, the file may exist: the final upload chunk (${RANGE}) ` +
        'ended with no answer within 60 s after Microsoft 365 may have committed it. ' +
        'Check the target before restoring it again',
    ]);
    // Issue #893: the file is also listed, with where it was being written.
    expect(result.outcome_unknown).toEqual([
      { path: expect.stringMatching(/\/Reports\/file-1\.docx$/), error: result.errors[0] },
    ]);
  });

  it('lists a single-request upload whose create outcome is unknown (issue #893)', async () => {
    const unknown = new CreateOutcomeUnknownError('HTTP 502');
    const { service } = make_harness(() => Promise.reject(unknown));

    const result = await service.restore_sharepoint('tenant-1', 'site-1', {
      snapshot_id: 'sp-snap-1',
    });

    expect(result.errors).toEqual([`file-1.docx: ${unknown.message}`]);
    expect(result.outcome_unknown).toEqual([
      { path: expect.stringMatching(/\/Reports\/file-1\.docx$/), error: result.errors[0] },
    ]);
  });

  it.each([400, 404, 409, 413])(
    'does not list a file Graph refused with %i (issue #893)',
    async (status) => {
      const refused = Object.assign(new Error(`HTTP ${status}`), { statusCode: status });
      const { service } = make_harness(() => Promise.reject(refused));

      const result = await service.restore_sharepoint('tenant-1', 'site-1', {
        snapshot_id: 'sp-snap-1',
      });

      expect(result.errors).toEqual([`file-1.docx: HTTP ${status}`]);
      expect(result.outcome_unknown).toEqual([]);
    },
  );

  it('names the file when Ctrl+C was pressed while its final chunk was in flight', async () => {
    const { connector, service } = make_harness();
    const controller = new AbortController();

    const run = service.restore_sharepoint('tenant-1', 'site-1', {
      snapshot_id: 'sp-snap-1',
      abort_signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(55_000);
    const result = await run;

    expect(result.interrupted).toBe(true);
    expect(result.files_restored).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^file-1\.docx: outcome unknown, the file may exist/);
    expect(connector.upload_small_file).toHaveBeenCalledTimes(1);
  });
});
