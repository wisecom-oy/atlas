import type { StorageKeyClass, StorageRequestWorkload } from '@wisecom/atlas-types';

export interface StorageKeyClassification {
  readonly workload: StorageRequestWorkload;
  readonly key_class: StorageKeyClass;
}

/** Outlook keeps its prefixes at the bucket root (docs/operations/storage-layout.md). */
const OUTLOOK_CLASSES: Record<string, StorageKeyClass> = {
  data: 'data',
  attachments: 'attachments',
  manifests: 'manifests',
};

/** Prefixes under `onedrive/` and `sharepoint/`. */
const DRIVE_CLASSES: Record<string, StorageKeyClass> = {
  data: 'data',
  manifests: 'manifests',
  index: 'index',
  staging: 'staging',
  _meta: '_meta',
};

const BUCKET_LEVEL: StorageKeyClassification = { workload: 'bucket', key_class: 'other' };

/**
 * Names the part of the layout an object key or listing prefix belongs to.
 *
 * An allowlist over the leading segments only, so the result never carries the owner, site or
 * content hash that the rest of the key holds.
 */
export function classify_storage_key(key: string | undefined): StorageKeyClassification {
  if (!key) return BUCKET_LEVEL;
  const [first = '', second = ''] = key.split('/', 2);

  // Own properties only, so a segment such as `constructor` cannot resolve to a prototype member.
  if (first === 'onedrive' || first === 'sharepoint') {
    const drive_class = Object.hasOwn(DRIVE_CLASSES, second) ? DRIVE_CLASSES[second] : undefined;
    return { workload: first, key_class: drive_class ?? 'other' };
  }
  if (first === '_meta') return { workload: 'shared', key_class: '_meta' };

  const outlook_class = Object.hasOwn(OUTLOOK_CLASSES, first) ? OUTLOOK_CLASSES[first] : undefined;
  return outlook_class
    ? { workload: 'outlook', key_class: outlook_class }
    : { workload: 'shared', key_class: 'other' };
}
