import { logger } from '@wisecom/atlas-core/utils/logger';
import { is_active_run_cancelled } from '@wisecom/atlas-core/services/shared/graph-request-context';
import type { DriveManifestEntry } from '@/drive-ports';

/** Finds the newest entry an earlier snapshot holds for a file, or undefined. */
export type PreviousEntryLookup = (file_id: string) => Promise<DriveManifestEntry | undefined>;

/** A lookup for a run with no earlier snapshot, or a caller that never needs one. */
export const NO_PREVIOUS_ENTRIES: PreviousEntryLookup = () => Promise.resolve(undefined);

/**
 * Builds a lookup that reads the earlier snapshots at most once per run, and only when a run first
 * asks. That happens when a file's sharing changed and its content did not: the new entry reuses
 * the stored blob instead of downloading the file again. Reading the chain costs one manifest read
 * per earlier snapshot, so a run with no such file reads nothing.
 *
 * A chain that cannot be read (a damaged manifest, say) is logged and treated as empty. The caller
 * then downloads the file as for a content change, which costs time but never loses the change.
 */
export function create_previous_entry_lookup(
  load_entries: () => Promise<readonly DriveManifestEntry[]>,
): PreviousEntryLookup {
  let loaded: Promise<Map<string, DriveManifestEntry>> | undefined;
  return async (file_id) => {
    loaded ??= load_entry_map(load_entries);
    return (await loaded).get(file_id);
  };
}

async function load_entry_map(
  load_entries: () => Promise<readonly DriveManifestEntry[]>,
): Promise<Map<string, DriveManifestEntry>> {
  try {
    const entries = await load_entries();
    return new Map(entries.map((entry) => [entry.file_id, entry]));
  } catch (err) {
    if (is_active_run_cancelled()) throw err;
    logger.warn(
      'Earlier snapshots could not be read to carry a sharing change forward; files whose sharing ' +
        `changed are downloaded again instead: ${err instanceof Error ? err.message : String(err)}`,
    );
    return new Map();
  }
}
