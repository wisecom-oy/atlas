import { QUARANTINE_PREFIX } from '@/services/quarantine/stored-object-quarantine';

/** Where each workload's tree starts: Outlook at the bucket root, the others under their name. */
const WORKLOAD_TREES = ['', 'onedrive/', 'sharepoint/', 'teams/', 'calendar/', 'contacts/'];

/**
 * Every prefix that holds manifests, quarantined copies included. A manifest outside these is
 * still erased, only without the guarantee that it goes before the data it references.
 */
export const MANIFEST_ROOTS: readonly string[] = [
  ...WORKLOAD_TREES,
  ...WORKLOAD_TREES.map((tree) => `${QUARANTINE_PREFIX}${tree}`),
].map((tree) => `${tree}manifests/`);

/**
 * The manifest roots strictly inside `scope`, which a sweep of the scope erases first. A scope that
 * is itself a manifest root, or lies inside one, has none.
 */
export function manifest_roots_within(scope: string): string[] {
  return MANIFEST_ROOTS.filter((root) => root !== scope && root.startsWith(scope));
}
