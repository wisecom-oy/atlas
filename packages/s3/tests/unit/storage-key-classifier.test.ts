import { describe, expect, it } from 'vitest';
import { classify_storage_key } from '@/adapters/storage-key-classifier';

describe('classify_storage_key', () => {
  // Every prefix in docs/operations/storage-layout.md.
  it.each([
    ['_meta/dek.enc', 'shared', '_meta'],
    ['_meta/outlook-manifests/owners/m/latest.json', 'shared', '_meta'],
    ['_meta/replication/onedrive/o/s.json', 'shared', '_meta'],
    ['data/m/0123abcd', 'outlook', 'data'],
    ['attachments/m/0123abcd', 'outlook', 'attachments'],
    ['manifests/m/s.json', 'outlook', 'manifests'],
    ['onedrive/data/o/0123abcd', 'onedrive', 'data'],
    ['onedrive/manifests/o/s.json', 'onedrive', 'manifests'],
    ['onedrive/index/o/runs/s.json', 'onedrive', 'index'],
    ['onedrive/staging/o/item-rand', 'onedrive', 'staging'],
    ['onedrive/_meta/o/delta.json', 'onedrive', '_meta'],
    ['sharepoint/data/s/0123abcd', 'sharepoint', 'data'],
    ['sharepoint/index/s/files/f.json', 'sharepoint', 'index'],
    ['sharepoint/staging/s/item-rand', 'sharepoint', 'staging'],
    ['sharepoint/_meta/s/delta.json', 'sharepoint', '_meta'],
  ])('%s → %s/%s', (key, workload, key_class) => {
    expect(classify_storage_key(key)).toEqual({ workload, key_class });
  });

  it.each([
    ['unknown/thing', 'shared'],
    ['onedrive/unknown/o', 'onedrive'],
    ['constructor/x', 'shared'],
    ['onedrive/constructor/x', 'onedrive'],
  ])('maps the unlisted key %s to other', (key, workload) => {
    expect(classify_storage_key(key)).toEqual({ workload, key_class: 'other' });
  });

  it('treats a request without a key or prefix as bucket-level', () => {
    expect(classify_storage_key(undefined)).toEqual({ workload: 'bucket', key_class: 'other' });
    expect(classify_storage_key('')).toEqual({ workload: 'bucket', key_class: 'other' });
  });
});
