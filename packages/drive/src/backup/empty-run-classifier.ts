import type { NoSnapshotReason } from '@wisecom/atlas-types';

/** What the run already knows, plus the lookup it should only need in the empty case. */
export interface EmptyRunEvidence {
  /** Kinds the delta cursor records per file id, carried from earlier runs and this one. */
  readonly previous_kind_by_file_id: Record<string, 'file' | 'folder'>;
  /** Items this run walked, which is above zero whenever a crawl saw anything at all. */
  readonly items_processed: number;
  /** Reads the newest snapshot for the resource. Called only when nothing else proves content. */
  readonly find_latest_snapshot: () => Promise<unknown | undefined>;
}

/**
 * Decides why a completed run wrote no snapshot: the resource holds nothing, or nothing changed.
 *
 * A resource with content and one with none returned an identical empty result, so a consumer
 * could not separate an unprotected site from a covered one and reported both as backed up
 * (issue #405). Shared because OneDrive and SharePoint answer it the same way, differing only in
 * which manifest lookup names the resource.
 *
 * Content is proved for free by what the run walked or by what the cursor already knows. Only
 * when neither shows a file does it spend the lookup, because a cursor written before a field
 * existed, or a run whose every file failed, would otherwise report a covered resource as empty.
 * Reaching the lookup means the resource really does look empty, which is the rare path.
 */
export async function classify_empty_run(evidence: EmptyRunEvidence): Promise<NoSnapshotReason> {
  const knows_a_file = Object.values(evidence.previous_kind_by_file_id).includes('file');
  if (evidence.items_processed > 0 || knows_a_file) return 'no_changes';
  const existing = await evidence.find_latest_snapshot();
  return existing === undefined ? 'no_content' : 'no_changes';
}
