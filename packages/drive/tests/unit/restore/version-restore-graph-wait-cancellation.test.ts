/**
 * Issue #682. Version restore read its interrupt flag only between versions and never ran under
 * the abort signal, so Ctrl+C during an upload parked in a Graph Retry-After sat the wait out.
 */
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import {
  WrongPassphraseError,
  type TenantContext,
  type TenantContextFactory,
} from '@wisecom/atlas-types';
import { DriveDecryptAuthError } from '@/restore/decrypt-auth-error';
import type { DriveFileVersionIndexView, DriveFileVersionRecord } from '@/drive-ports';
import { restore_drive_version, type DriveVersionRestoreDeps } from '@/restore/version-restore';
import { readable_indexes } from '@wisecom/atlas-types/testing/readable-listing';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const CUTOFF = new Date('2026-03-10T00:00:00Z');

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

function index(file_id: string): DriveFileVersionIndexView {
  const version = {
    snapshot_id: 'snap-1',
    backup_at: '2026-03-01T00:00:00.000Z',
    drive_id: 'drive-1',
    file_name: `${file_id}.docx`,
    parent_path: '/Documents',
    size_bytes: 7,
    storage_key: `onedrive/data/owner-1/${file_id}`,
    checksum: 'abc',
    change_type: 'updated',
    last_modified_at: '2026-03-01T00:00:00.000Z',
    version_id: '1.0',
  } as DriveFileVersionRecord;
  return { file_id, versions: [version] };
}

function make_deps(): DriveVersionRestoreDeps & { connector: { upload_small_file: unknown } } {
  const ctx = { destroy: vi.fn() } as unknown as TenantContext;
  return {
    workload: 'onedrive',
    tenant_factory: {
      create_readonly: vi.fn().mockResolvedValue(ctx),
    } as unknown as TenantContextFactory,
    leases: stub_owner_leases().leases,
    connector: {
      upload_small_file: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementation(graph_call_parked_in_retry_wait),
      upload_large_file: vi.fn().mockResolvedValue(undefined),
    },
    list_indexes: vi
      .fn()
      .mockResolvedValue(readable_indexes([index('file-1'), index('file-2'), index('file-3')])),
    download_blob: vi.fn().mockResolvedValue(Buffer.from('content')),
    ensure_folder_path: vi.fn().mockResolvedValue('folder-1'),
  };
}

describe('restore_drive_version cancelled during a Graph retry wait (issue #682)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ends the upload wait within a second and reports the versions already restored', async () => {
    const deps = make_deps();
    const controller = new AbortController();
    let settled = false;

    const run = restore_drive_version(deps, 'tenant-1', 'owner-1', {
      before: CUTOFF,
      abort_signal: controller.signal,
    }).finally(() => (settled = true));
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
    expect(deps.connector.upload_small_file).toHaveBeenCalledTimes(2);
  });

  it('surfaces a key error that lands after the signal instead of reporting nothing restored', async () => {
    const deps = make_deps();
    const controller = new AbortController();
    vi.mocked(deps.download_blob)
      .mockResolvedValueOnce(Buffer.from('content'))
      .mockImplementationOnce(async (_ctx, version) => {
        controller.abort(new Error('Run interrupted by Ctrl+C'));
        throw new DriveDecryptAuthError(version.file_name);
      });

    const run = restore_drive_version(deps, 'tenant-1', 'owner-1', {
      before: CUTOFF,
      abort_signal: controller.signal,
    });

    await expect(run).rejects.toBeInstanceOf(WrongPassphraseError);
  });
});
