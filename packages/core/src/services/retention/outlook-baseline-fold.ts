import type { MailFolder, Manifest, ManifestEntry } from '@wisecom/atlas-types';

/**
 * Folds an Outlook baseline's chain one manifest at a time, newest first, so the older manifests
 * never all sit in memory together.
 *
 * The result is the baseline snapshot as its restore saw it: `merge_snapshot_entries` over the
 * chain, written as one self-sufficient manifest under the baseline's snapshot id. Its removals are
 * the baseline's own plus every message an older manifest holds that the fold hides. Those hide the
 * same messages in any older manifest that outlives the prune, because Object Lock retains it, so
 * the chain reads the same with or without it. Removals older manifests recorded are not carried:
 * they only hid entries of manifests the prune removes, and those entries are covered above.
 */
export class OutlookBaselineFold {
  private readonly _entries: ManifestEntry[] = [];
  private readonly _live = new Set<string>();
  private readonly _seen = new Set<string>();
  private readonly _hidden: string[] = [];
  private readonly _hidden_set = new Set<string>();
  private readonly _folders = new Map<string, MailFolder>();
  private _target: Manifest | undefined;

  /** Adds the next manifest of the chain: the baseline first, then each older one. */
  add(manifest: Manifest): void {
    const is_target = this._target === undefined;
    this._target ??= manifest;
    for (const entry of manifest.entries) this.add_entry(entry, is_target);
    for (const folder of manifest.folders ?? []) {
      if (!this._folders.has(folder.folder_id)) this._folders.set(folder.folder_id, folder);
    }
    for (const removed_id of manifest.removed_object_ids ?? []) this._seen.add(removed_id);
  }

  /** The folded baseline. */
  result(): Manifest {
    const target = this._target;
    if (target === undefined) throw new Error('An Outlook baseline fold needs the baseline first');
    const removed = union_in_order(target.removed_object_ids ?? [], this._hidden);
    const folders = [...this._folders.values()];
    const baseline: Manifest = {
      ...target,
      total_objects: Math.max(target.total_objects, this._entries.length),
      total_size_bytes: total_size_of(this._entries),
      entries: this._entries,
    };
    return with_optional_lists(baseline, folders, removed);
  }

  private add_entry(entry: ManifestEntry, is_target: boolean): void {
    if (!this._seen.has(entry.object_id)) {
      this._seen.add(entry.object_id);
      this._live.add(entry.object_id);
      this._entries.push(entry);
      return;
    }
    if (is_target || this._live.has(entry.object_id)) return;
    if (this._hidden_set.has(entry.object_id)) return;
    this._hidden_set.add(entry.object_id);
    this._hidden.push(entry.object_id);
  }
}

/** Folds a whole chain at once, newest first; the first manifest is the baseline. */
export function fold_outlook_baseline(chain: readonly Manifest[]): Manifest {
  const fold = new OutlookBaselineFold();
  for (const manifest of chain) fold.add(manifest);
  return fold.result();
}

/** Whether the stored baseline already holds what the fold produced, so no write is needed. */
export function outlook_baseline_matches(stored: Manifest, folded: Manifest): boolean {
  return (
    JSON.stringify(comparable_outlook_fields(stored)) ===
    JSON.stringify(comparable_outlook_fields(folded))
  );
}

function comparable_outlook_fields(manifest: Manifest): unknown {
  return [
    manifest.entries,
    manifest.removed_object_ids ?? [],
    manifest.folders ?? [],
    manifest.total_objects,
    manifest.total_size_bytes,
  ];
}

/** Sets or drops `folders` and `removed_object_ids`, which a manifest omits when empty. */
function with_optional_lists(
  baseline: Manifest,
  folders: MailFolder[],
  removed: string[],
): Manifest {
  const { folders: _folders, removed_object_ids: _removed, ...rest } = baseline;
  return {
    ...rest,
    ...(folders.length > 0 && { folders }),
    ...(removed.length > 0 && { removed_object_ids: removed }),
  };
}

function union_in_order(first: readonly string[], second: readonly string[]): string[] {
  const seen = new Set(first);
  const union = [...first];
  for (const id of second) {
    if (seen.has(id)) continue;
    seen.add(id);
    union.push(id);
  }
  return union;
}

/** Message plus attachment bytes, as the backup computes a manifest's `total_size_bytes`. */
function total_size_of(entries: readonly ManifestEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    total += entry.size_bytes;
    for (const attachment of entry.attachments ?? []) total += attachment.size_bytes;
  }
  return total;
}
