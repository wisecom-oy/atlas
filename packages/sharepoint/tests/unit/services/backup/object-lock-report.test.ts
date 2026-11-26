import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import type {
  ObjectLockRequest,
  SharePointBackupOptions,
  SharePointSite,
  SharePointSnapshotManifest,
} from '@wisecom/atlas-types';
import { SharePointSiteTreeBackupService } from '@/services/backup/site-tree-backup.service';
import {
  make_connector,
  make_file_item,
  make_manifests,
  make_service,
} from './backup-determinism.fixtures';

// Issue #975: a SharePoint run records the Object Lock policy it stamped on its objects, on the
// manifest it writes and on the result it returns, the way an Outlook run does.

const DAY_MS = 86_400_000;

function delta_with(items: ReturnType<typeof make_file_item>[]) {
  return vi.fn().mockResolvedValue({
    drive_id: 'drive-1',
    delta_link: 'https://next',
    items,
    reset_detected: false,
  });
}

function saved_manifests(manifests: ReturnType<typeof make_manifests>) {
  return vi.mocked(manifests.save).mock.calls.map(([, m]) => m as SharePointSnapshotManifest);
}

async function backup(with_changes: boolean, request?: ObjectLockRequest) {
  const manifests = make_manifests();
  const connector = make_connector({
    fetch_delta: delta_with(with_changes ? [make_file_item('f1')] : []),
  });
  const options: SharePointBackupOptions = request ? { object_lock_request: request } : {};
  const result = await make_service({ connector, manifests }).backup_site('t', 'site-1', options);
  return { result, saved: saved_manifests(manifests) };
}

function subsite(site_id: string): SharePointSite {
  return {
    site_id,
    site_url: `https://example.invalid/${site_id}`,
    display_name: site_id,
    kind: 'site',
  };
}

describe('SharePoint backup Object Lock report (#975)', () => {
  it('records the requested and the applied policy on the manifest it writes', async () => {
    const { saved } = await backup(true, { mode: 'COMPLIANCE', retention_days: 30 });

    const object_lock = saved[0]?.object_lock;
    expect(object_lock?.requested).toEqual({ mode: 'COMPLIANCE', retention_days: 30 });
    expect(object_lock?.effective.mode).toBe('COMPLIANCE');
    const days = (Date.parse(object_lock?.effective.retain_until ?? '') - Date.now()) / DAY_MS;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
  });

  it('returns the same policy on the result and on its snapshot', async () => {
    const { result, saved } = await backup(true, { retention_days: 7 });

    expect(result.object_lock).toEqual(saved[0]?.object_lock);
    expect(result.snapshot?.object_lock).toEqual(saved[0]?.object_lock);
    expect(result.object_lock?.effective.mode).toBe('GOVERNANCE');
  });

  it('writes no policy without a lock request', async () => {
    const { result, saved } = await backup(true);

    expect(saved[0]).not.toHaveProperty('object_lock');
    expect(result).not.toHaveProperty('object_lock');
  });

  it('reports the policy on a run that created no snapshot', async () => {
    const { result, saved } = await backup(false, { retention_days: 7 });

    expect(saved).toEqual([]);
    expect(result.snapshot).toBeUndefined();
    expect(result.object_lock?.requested.retention_days).toBe(7);
  });

  it('records the policy on every site snapshot with include_subsites', async () => {
    const manifests = make_manifests();
    const connector = make_connector({
      fetch_delta: delta_with([make_file_item('f1')]),
      list_subsites: vi.fn().mockResolvedValue({
        sites: [subsite('sub-1'), subsite('sub-2')],
        warnings: [],
        errors: [],
      }),
    });
    const tree = new SharePointSiteTreeBackupService(
      connector,
      make_service({ connector, manifests }),
    );

    const results = await tree.backup_site_tree('t', 'root', {
      include_subsites: true,
      object_lock_request: { mode: 'GOVERNANCE', retention_days: 14 },
    });

    const saved = saved_manifests(manifests);
    expect(saved.map((m) => m.site_id)).toEqual(['root', 'sub-1', 'sub-2']);
    for (const manifest of saved) {
      expect(manifest.object_lock?.requested).toEqual({ mode: 'GOVERNANCE', retention_days: 14 });
      expect(manifest.object_lock?.effective.mode).toBe('GOVERNANCE');
    }
    expect(results.map((r) => r.object_lock?.requested.retention_days)).toEqual([14, 14, 14]);
  });
});
