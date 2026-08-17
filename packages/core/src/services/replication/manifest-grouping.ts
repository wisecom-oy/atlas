/**
 * Groups manifests by their owning scope (mailbox owner, OneDrive owner, SharePoint site).
 *
 * Tenant-wide replication and recovery must work per scope, not per manifest: ancillary objects
 * (version indexes, delta cursors) and target diffs are addressed by scope prefix, so processing a
 * flat manifest list would apply one scope's sidecars to another's snapshots.
 */
export function group_manifests_by_scope<T>(
  manifests: readonly T[],
  scope_of: (manifest: T) => string,
): Map<string, T[]> {
  const by_scope = new Map<string, T[]>();
  for (const manifest of manifests) {
    const scope = scope_of(manifest);
    const bucket = by_scope.get(scope);
    if (bucket) bucket.push(manifest);
    else by_scope.set(scope, [manifest]);
  }
  return by_scope;
}
