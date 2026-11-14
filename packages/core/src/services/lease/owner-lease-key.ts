import type { OwnerLeaseWorkload } from '@wisecom/atlas-types';

const UNSAFE_SEGMENT = /[/\\\0]/;

/**
 * The tenant-wide lease, taken by a purge or a key re-wrap (issue #739). It sits directly under
 * `_meta/`, outside every workload's `_meta/` listing and outside the `_meta/outlook-leases/`
 * prefix, so the owner scan never reads it as an owner lease.
 */
export const TENANT_LEASE_KEY = '_meta/tenant-lease.json';

/**
 * The key of an owner's lease object, next to the owner's delta cursor in each workload's layout
 * (docs/operations/storage-layout.md). Outlook keeps its metadata at the bucket root, so its lease
 * sits under `_meta/outlook-leases/`; every other workload keeps it in the owner's own `_meta`
 * directory, which deleting the owner already removes. The tenant lease ignores `owner_id`.
 */
export function owner_lease_key(workload: OwnerLeaseWorkload, owner_id: string): string {
  if (workload === 'tenant') return TENANT_LEASE_KEY;
  const owner = require_plain_key_segment(owner_id);
  return `${owner_lease_prefix(workload)}${owner}${owner_lease_suffix(workload)}`;
}

/** The prefix every owner lease of one workload shares, which the tenant-side scan lists. */
export function owner_lease_prefix(workload: Exclude<OwnerLeaseWorkload, 'tenant'>): string {
  return workload === 'outlook' ? '_meta/outlook-leases/' : `${workload}/_meta/`;
}

function owner_lease_suffix(workload: OwnerLeaseWorkload): string {
  return workload === 'outlook' ? '.json' : '/lease.json';
}

/**
 * The owner id a key under a workload's lease prefix names, or undefined when the key is not
 * exactly that workload's owner lease. The check rebuilds the key from the id it extracted, so a
 * cursor, a nested key or a stray object never passes.
 */
export function owner_id_of_lease_key(
  workload: Exclude<OwnerLeaseWorkload, 'tenant'>,
  key: string,
): string | undefined {
  const prefix = owner_lease_prefix(workload);
  const suffix = owner_lease_suffix(workload);
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) return undefined;
  const owner = key.slice(prefix.length, key.length - suffix.length);
  if (!is_plain_key_segment(owner)) return undefined;
  return owner_lease_key(workload, owner) === key ? owner : undefined;
}

/** Rejects an owner id that would escape its prefix or name nothing usable. */
function require_plain_key_segment(owner_id: string): string {
  if (!is_plain_key_segment(owner_id)) {
    throw new Error(`Owner id "${owner_id}" cannot be used as a storage key segment`);
  }
  return owner_id;
}

function is_plain_key_segment(segment: string): boolean {
  return segment !== '' && segment !== '.' && segment !== '..' && !UNSAFE_SEGMENT.test(segment);
}
