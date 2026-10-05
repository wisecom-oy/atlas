import { describe, it, expect } from 'vitest';
import {
  place_storage_key,
  tally_object,
  tally_upload,
  to_totals,
  type UsageTally,
} from '@/services/stats/storage-usage-tally';

describe('place_storage_key', () => {
  // Every prefix in docs/operations/storage-layout.md, plus keys outside it.
  it.each([
    ['data/m1/abc', 'outlook', 'm1'],
    ['attachments/m1/abc', 'outlook', 'm1'],
    ['manifests/m1/snap.json', 'outlook', 'm1'],
    ['onedrive/data/o1/abc', 'onedrive', 'o1'],
    ['onedrive/manifests/o1/snap.json', 'onedrive', 'o1'],
    ['onedrive/index/o1/runs/snap.json', 'onedrive', 'o1'],
    ['onedrive/staging/o1/item-rand', 'onedrive', 'o1'],
    ['onedrive/_meta/o1/delta.json', 'onedrive', 'o1'],
    ['sharepoint/data/contoso.sharepoint.com,a,b/abc', 'sharepoint', 'contoso.sharepoint.com,a,b'],
    ['_meta/dek.enc', 'meta', ''],
    ['_meta/outlook-manifests/owners/m1/latest.json', 'meta', ''],
    ['root-file', 'other', ''],
    ['unknown/x/y', 'other', ''],
    ['data/loose', 'outlook', ''],
  ])('%s → %s owner %s', (key, workload, owner_id) => {
    expect(place_storage_key(key)).toEqual({ workload, owner_id });
  });
});

describe('tally_object and tally_upload', () => {
  it('sorts versions, markers, staging and uploads into their workload and owner', () => {
    const tally: UsageTally = { by_workload: {}, by_owner: {} };

    tally_object(tally, {
      key: 'onedrive/data/o1/a',
      size: 100,
      is_latest: true,
      is_delete_marker: false,
    });
    tally_object(tally, {
      key: 'onedrive/data/o1/a',
      size: 90,
      is_latest: false,
      is_delete_marker: false,
    });
    tally_object(tally, {
      key: 'onedrive/data/o1/b',
      size: 0,
      is_latest: true,
      is_delete_marker: true,
    });
    tally_object(tally, {
      key: 'onedrive/staging/o1/x',
      size: 50,
      is_latest: true,
      is_delete_marker: false,
    });
    tally_upload(tally, { key: 'onedrive/staging/o1/y', bytes: 6000 });

    const expected = {
      current: { objects: 2, bytes: 150 },
      noncurrent: { objects: 1, bytes: 90 },
      delete_markers: 1,
      staging: { objects: 1, bytes: 50 },
      incomplete_uploads: { objects: 1, bytes: 6000 },
    };
    expect(to_totals(tally.by_workload['onedrive']!)).toEqual(expected);
    expect(to_totals(tally.by_owner!['onedrive/o1']!)).toEqual(expected);
  });

  it('tracks no owners unless the owner breakdown was requested', () => {
    const tally: UsageTally = { by_workload: {} };

    tally_object(tally, { key: 'data/m1/a', size: 1, is_latest: true, is_delete_marker: false });

    expect(tally.by_owner).toBeUndefined();
    expect(tally.by_workload['outlook']?.current_objects).toBe(1);
  });
});
