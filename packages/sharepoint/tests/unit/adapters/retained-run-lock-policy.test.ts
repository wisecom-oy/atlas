import { describe, expect, it } from 'vitest';
import type {
  SharePointDeltaCursor,
  SharePointFileVersionIndex,
  SharePointSnapshotManifest,
  TenantContext,
} from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { record_lock_policies } from '@wisecom/atlas-types/testing/lock-policy-recorder';
import { stub_drive_version_download } from '@wisecom/atlas-types/testing/stub-drive-version-download';
import { ObjectLockingStorage } from '@wisecom/atlas-core/services/shared/run-object-lock';
import { store_version_content } from '@wisecom/atlas-drive/versioning/version-content-store';
import type { DriveContentConnector, DriveDeltaItem } from '@wisecom/atlas-drive/drive-ports';
import { S3SharePointDeltaCursorRepository } from '@/adapters/s3-sharepoint-delta-cursor-repository.adapter';
import { S3SharePointFileVersionIndexRepository } from '@/adapters/s3-sharepoint-file-version-index-repository.adapter';
import { S3SharePointManifestRepository } from '@/adapters/s3-sharepoint-manifest-repository.adapter';
import {
  SHAREPOINT_KEYS,
  sharepoint_delta_cursor_key,
  sharepoint_manifest_key,
  sharepoint_run_index_key,
} from '@/services/shared/storage-keys';

/**
 * Issue #919: a run with `--retention-days` locked every cursor and summary index version it
 * wrote, which the noncurrent-version rule could then not expire. Backup data keeps the lock.
 */

const SITE = 'site-1';
const SNAPSHOT = 'sp-snap-1000-abc';
const RUN_POLICY = { mode: 'GOVERNANCE' as const, retain_until: '2030-01-01T00:00:00.000Z' };

function retained_run() {
  const harness = in_memory_tenant_context();
  const recorder = record_lock_policies(harness.ctx.storage);
  const ctx: TenantContext = {
    ...harness.ctx,
    storage: new ObjectLockingStorage(recorder.storage, RUN_POLICY),
  };
  return { ctx, recorder };
}

describe('SharePoint writes under a retained run', () => {
  it('locks content, the manifest and the run version index, and nothing else', async () => {
    const { ctx, recorder } = retained_run();
    const connector = {
      download_file_version: stub_drive_version_download(),
    } as unknown as DriveContentConnector;
    const item = { item_id: 'item-1', drive_id: 'drive-1', file_name: 'f' } as DriveDeltaItem;
    const version = { version_id: 'v1', size_bytes: 8, last_modified_at: '2026-01-01T00:00:00Z' };
    const manifest: SharePointSnapshotManifest = {
      id: `${SITE}-${SNAPSHOT}`,
      tenant_id: 'tenant-1',
      site_id: SITE,
      snapshot_id: SNAPSHOT,
      created_at: new Date(1000),
      total_files: 0,
      total_size_bytes: 0,
      entries: [],
    };
    const index = {
      file_id: 'file-1',
      site_id: SITE,
      versions: [{ snapshot_id: SNAPSHOT, backup_at: '2026-01-01T00:00:00.000Z' }],
    } as unknown as SharePointFileVersionIndex;

    const content = await store_version_content(
      SHAREPOINT_KEYS,
      connector,
      item,
      SITE,
      ctx,
      version,
    );
    await new S3SharePointManifestRepository().save(ctx, manifest);
    await new S3SharePointFileVersionIndexRepository().write_run_index(ctx, SITE, SNAPSHOT, [
      index,
    ]);
    await new S3SharePointDeltaCursorRepository().save(ctx, {
      site_id: SITE,
      delta_link_by_drive: {},
      previous_path_by_file_id: {},
      previous_name_by_file_id: {},
      previous_etag_by_file_id: {},
      previous_kind_by_file_id: {},
    } as SharePointDeltaCursor);

    expect(recorder.locked_keys()).toEqual(
      [
        content.storage_key,
        sharepoint_manifest_key(SITE, SNAPSHOT),
        sharepoint_run_index_key(SITE, SNAPSHOT),
      ].sort(),
    );
    expect(recorder.unlocked_keys()).toEqual(
      [sharepoint_delta_cursor_key(SITE), SHAREPOINT_KEYS.snapshot_summary_key(SITE)].sort(),
    );
  });
});
