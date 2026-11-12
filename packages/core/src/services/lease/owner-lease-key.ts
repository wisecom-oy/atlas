import type { OwnerLeaseWorkload } from '@wisecom/atlas-types';

const UNSAFE_SEGMENT = /[/\\\0]/;

/**
 * The key of an owner's lease object, next to the owner's delta cursor in each workload's layout
 * (docs/operations/storage-layout.md). Outlook keeps its metadata at the bucket root, so its lease
 * sits under `_meta/outlook-leases/`; every other workload keeps it in the owner's own `_meta`
 * directory, which deleting the owner already removes.
 */
export function owner_lease_key(workload: OwnerLeaseWorkload, owner_id: string): string {
  const owner = require_plain_key_segment(owner_id);
  return workload === 'outlook'
    ? `_meta/outlook-leases/${owner}.json`
    : `${workload}/_meta/${owner}/lease.json`;
}

/** Rejects an owner id that would escape its prefix or name nothing usable. */
function require_plain_key_segment(owner_id: string): string {
  if (owner_id === '' || owner_id === '.' || owner_id === '..' || UNSAFE_SEGMENT.test(owner_id)) {
    throw new Error(`Owner id "${owner_id}" cannot be used as a storage key segment`);
  }
  return owner_id;
}
