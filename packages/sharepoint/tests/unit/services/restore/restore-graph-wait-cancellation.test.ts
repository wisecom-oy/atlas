/**
 * Issue #682. The SharePoint restore read its interrupt flag only between files and never ran
 * under the abort signal, so Ctrl+C during an upload parked in a Graph Retry-After sat the wait
 * out. An upload cut short by the signal is the run stopping, not a skipped file.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import type {
  SharePointManifestEntry,
  SharePointManifestRepository,
  SharePointSiteConnector,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { SharePointRestoreService } from '@/services/restore/restore.service';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

const CONTENT = Buffer.from('restored-file-content');
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

function make_harness() {
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
    upload_small_file: vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementation(graph_call_parked_in_retry_wait),
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
    list_snapshots_by_site: vi.fn().mockResolvedValue([]),
  } as unknown as SharePointManifestRepository;
  return { connector, service: new SharePointRestoreService(factory, connector, manifests) };
}

describe('SharePoint restore cancelled during a Graph retry wait (issue #682)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ends the upload wait within a second and reports the files already restored', async () => {
    const { connector, service } = make_harness();
    const controller = new AbortController();
    let settled = false;

    const run = service
      .restore_sharepoint('tenant-1', 'site-1', {
        snapshot_id: 'sp-snap-1',
        abort_signal: controller.signal,
      })
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);

    controller.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(settled).toBe(true);
    const result = await run;
    expect(result.interrupted).toBe(true);
    expect(result.files_restored).toBe(1);
    expect(result.files_skipped).toBe(0);
    expect(result.errors).toEqual([]);
    expect(connector.upload_small_file).toHaveBeenCalledTimes(2);
  });
});
