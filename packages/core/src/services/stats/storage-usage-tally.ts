import type {
  StorageIncompleteUpload,
  StorageListedObject,
  StorageOwnerUsage,
  StorageUsageTotals,
  StorageUsageWorkload,
} from '@wisecom/atlas-types';

/** Running counts for one workload or owner. Plain data, so it survives a continuation token. */
export interface UsageCounts {
  current_objects: number;
  current_bytes: number;
  noncurrent_objects: number;
  noncurrent_bytes: number;
  delete_markers: number;
  staging_objects: number;
  staging_bytes: number;
  upload_count: number;
  upload_bytes: number;
}

/** Accumulated counts, keyed by workload and, when requested, by `workload/owner_id`. */
export interface UsageTally {
  by_workload: Record<string, UsageCounts>;
  by_owner?: Record<string, UsageCounts>;
}

interface KeyPlacement {
  readonly workload: StorageUsageWorkload;
  readonly owner_id: string;
}

const OUTLOOK_PREFIXES = ['data', 'attachments', 'manifests'];
const STAGING_PATTERN = /^(onedrive|sharepoint)\/staging\//;

/**
 * Places a key in the layout of docs/operations/storage-layout.md. Outlook keeps owners at the
 * second segment (`data/{mailbox}/...`), the drives at the third (`onedrive/data/{owner}/...`).
 */
export function place_storage_key(key: string): KeyPlacement {
  const segments = key.split('/');
  const [first = '', second = '', third = ''] = segments;
  const has_child = (index: number): boolean => segments.length > index + 1;
  if (first === 'onedrive' || first === 'sharepoint') {
    return { workload: first, owner_id: has_child(2) ? third : '' };
  }
  if (first === '_meta') return { workload: 'meta', owner_id: '' };
  if (OUTLOOK_PREFIXES.includes(first)) {
    return { workload: 'outlook', owner_id: has_child(1) ? second : '' };
  }
  return { workload: 'other', owner_id: '' };
}

export function empty_counts(): UsageCounts {
  return {
    current_objects: 0,
    current_bytes: 0,
    noncurrent_objects: 0,
    noncurrent_bytes: 0,
    delete_markers: 0,
    staging_objects: 0,
    staging_bytes: 0,
    upload_count: 0,
    upload_bytes: 0,
  };
}

/** Adds one listed version, delete marker or live object to its workload and owner. */
export function tally_object(tally: UsageTally, object: StorageListedObject): void {
  for (const counts of counts_for(tally, object.key)) {
    if (object.is_delete_marker) {
      counts.delete_markers++;
      continue;
    }
    if (object.is_latest) {
      counts.current_objects++;
      counts.current_bytes += object.size;
    } else {
      counts.noncurrent_objects++;
      counts.noncurrent_bytes += object.size;
    }
    if (STAGING_PATTERN.test(object.key)) {
      counts.staging_objects++;
      counts.staging_bytes += object.size;
    }
  }
}

/** Adds one incomplete multipart upload to its workload and owner. */
export function tally_upload(tally: UsageTally, upload: StorageIncompleteUpload): void {
  for (const counts of counts_for(tally, upload.key)) {
    counts.upload_count++;
    counts.upload_bytes += upload.bytes;
  }
}

/** The counts an object adds to: its workload's, and its owner's when owners are tracked. */
function counts_for(tally: UsageTally, key: string): UsageCounts[] {
  const { workload, owner_id } = place_storage_key(key);
  const targets = [(tally.by_workload[workload] ??= empty_counts())];
  if (tally.by_owner) targets.push((tally.by_owner[`${workload}/${owner_id}`] ??= empty_counts()));
  return targets;
}

/** Public shape of one set of counts. */
export function to_totals(counts: UsageCounts): StorageUsageTotals {
  return {
    current: { objects: counts.current_objects, bytes: counts.current_bytes },
    noncurrent: { objects: counts.noncurrent_objects, bytes: counts.noncurrent_bytes },
    delete_markers: counts.delete_markers,
    staging: { objects: counts.staging_objects, bytes: counts.staging_bytes },
    incomplete_uploads: { objects: counts.upload_count, bytes: counts.upload_bytes },
  };
}

/** Sums every workload's counts, so the totals equal the breakdown by construction. */
export function sum_counts(all: Iterable<UsageCounts>): UsageCounts {
  const total = empty_counts();
  for (const counts of all) {
    for (const field of Object.keys(total) as (keyof UsageCounts)[]) total[field] += counts[field];
  }
  return total;
}

/** Owner rows, largest stored footprint first; ties by workload and id so output is stable. */
export function owner_rows(by_owner: Record<string, UsageCounts>): StorageOwnerUsage[] {
  return Object.entries(by_owner)
    .map(([key, counts]) => {
      const slash = key.indexOf('/');
      return {
        workload: key.slice(0, slash) as StorageUsageWorkload,
        owner_id: key.slice(slash + 1),
        totals: to_totals(counts),
        stored: counts.current_bytes + counts.noncurrent_bytes + counts.upload_bytes,
      };
    })
    .sort(
      (a, b) =>
        b.stored - a.stored ||
        a.workload.localeCompare(b.workload) ||
        a.owner_id.localeCompare(b.owner_id),
    )
    .map(({ workload, owner_id, totals }) => ({ workload, owner_id, totals }));
}
