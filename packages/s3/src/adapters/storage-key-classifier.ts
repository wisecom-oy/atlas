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

/** Prefixes under `contacts/`; contact photos count as data. */
const CONTACTS_CLASSES: Record<string, StorageKeyClass> = {
  data: 'data',
  photos: 'data',
  manifests: 'manifests',
  _meta: '_meta',
};

/** Prefixes under `calendar/`; attachment bytes are their own class. */
const CALENDAR_CLASSES: Record<string, StorageKeyClass> = {
  data: 'data',
  attachments: 'attachments',
  manifests: 'manifests',
  _meta: '_meta',
};

/** Prefixes under `teams/`; channel shards count as index. */
const TEAMS_CLASSES: Record<string, StorageKeyClass> = {
  data: 'data',
  manifests: 'manifests',
  shards: 'index',
  _meta: '_meta',
};

/** Workloads that live under their own top-level prefix, with the classes of their second segment. */
const PREFIXED_WORKLOADS: Record<
  string,
  readonly [StorageRequestWorkload, Record<string, StorageKeyClass>]
> = {
  onedrive: ['onedrive', DRIVE_CLASSES],
  sharepoint: ['sharepoint', DRIVE_CLASSES],
  teams: ['teams', TEAMS_CLASSES],
  contacts: ['contacts', CONTACTS_CLASSES],
  calendar: ['calendar', CALENDAR_CLASSES],
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
  const prefixed = Object.hasOwn(PREFIXED_WORKLOADS, first) ? PREFIXED_WORKLOADS[first] : undefined;
  if (prefixed !== undefined) {
    const [workload, classes] = prefixed;
    return {
      workload,
      key_class: (Object.hasOwn(classes, second) ? classes[second] : undefined) ?? 'other',
    };
  }
  if (first === '_meta') return { workload: 'shared', key_class: '_meta' };

  const outlook_class = Object.hasOwn(OUTLOOK_CLASSES, first) ? OUTLOOK_CLASSES[first] : undefined;
  return outlook_class
    ? { workload: 'outlook', key_class: outlook_class }
    : { workload: 'shared', key_class: 'other' };
}
