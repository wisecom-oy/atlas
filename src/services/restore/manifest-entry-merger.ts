import type { Manifest, ManifestEntry } from '@/domain/manifest';
import type { ManifestRepository } from '@/ports/storage/manifest-repository.port';
import type { TenantContext } from '@/ports/tenant/context.port';

/**
 * Filters manifests to those whose created_at falls within the date range.
 * Both boundaries are inclusive. Undefined means unbounded.
 */
export function filter_manifests_by_date(
  manifests: Manifest[],
  start_date?: Date,
  end_date?: Date,
): Manifest[] {
  return manifests.filter((m) => {
    const ts = new Date(m.created_at).getTime();
    if (start_date && ts < start_date.getTime()) return false;
    if (end_date && ts > end_date.getTime() + 86_400_000 - 1) return false;
    return true;
  });
}

/** Loads all manifests for a mailbox, sorted newest-first and date-filtered. */
export async function load_mailbox_manifests(
  manifests_repo: ManifestRepository,
  ctx: TenantContext,
  mailbox_id: string,
  start_date?: Date,
  end_date?: Date,
): Promise<Manifest[]> {
  const all = await manifests_repo.list_all_manifests(ctx);
  const for_mailbox = all
    .filter((m) => m.mailbox_id === mailbox_id)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return filter_manifests_by_date(for_mailbox, start_date, end_date);
}

/**
 * Merges entries from multiple manifests, deduplicating by object_id.
 * Manifests must be sorted newest-first; the first occurrence of each
 * object_id wins (newest snapshot version takes precedence).
 *
 * Returns a flat deduplicated array preserving insertion order.
 */
export function merge_snapshot_entries(manifests: Manifest[]): ManifestEntry[] {
  const seen = new Set<string>();
  const merged: ManifestEntry[] = [];

  for (const manifest of manifests) {
    for (const entry of manifest.entries) {
      if (seen.has(entry.object_id)) continue;
      seen.add(entry.object_id);
      merged.push(entry);
    }
  }

  return merged;
}
