import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import { drive_quarantine_target } from '@/shared/drive-quarantine-target';
import { build_drive_storage_keys } from '@/shared/storage-keys';

const CTX = {} as TenantContext;

function target() {
  const reads = { read_manifest: vi.fn(), read_index_object: vi.fn() };
  return {
    reads,
    target: drive_quarantine_target('OneDrive', build_drive_storage_keys('onedrive'), reads),
  };
}

describe('drive_quarantine_target', () => {
  it.each([
    ['onedrive/manifests/owner-1/od-snap-1-abc.json', 'manifest'],
    ['onedrive/index/owner-1/runs/od-snap-1-abc.json', 'version_index'],
    ['onedrive/index/owner-1/files/file-1.json', 'version_index'],
  ])('recognises %s as a %s', (key, kind) => {
    expect(target().target.kind_of(key)).toBe(kind);
  });

  it.each([
    'onedrive/data/owner-1/abc',
    'onedrive/_meta/owner-1/delta.json',
    'sharepoint/manifests/site-1/sp-snap-1-abc.json',
    'onedrive/manifests/owner-1/nested/od-snap-1-abc.json',
    'onedrive/manifests/../_meta/x.json',
    '_quarantine/onedrive/manifests/owner-1/od-snap-1-abc.json',
    'onedrive/manifests/./od-snap-1-abc.json',
    'onedrive/manifests/owner-1/..json',
    'onedrive/manifests/Owner-1/od-snap-1-abc.json',
    'onedrive/index/owner-1/file-1.json',
    'onedrive/index/owner-1/runs/./x.json',
    'onedrive/index/owner-1/files/..json',
    'onedrive/index/owner-1/other/x.json',
  ])('refuses %s, which is not a OneDrive manifest or version index', (key) => {
    expect(target().target.kind_of(key)).toBeUndefined();
  });

  it('reads each kind through its own repository', async () => {
    const { reads, target: t } = target();

    await t.read(CTX, 'onedrive/manifests/owner-1/od-snap-1-abc.json');
    await t.read(CTX, 'onedrive/index/owner-1/runs/od-snap-1-abc.json');

    expect(reads.read_manifest).toHaveBeenCalledTimes(1);
    expect(reads.read_index_object).toHaveBeenCalledTimes(1);
  });
});
