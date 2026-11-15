import type { SharePointDocumentLibrary, SharePointManifestEntry } from '@wisecom/atlas-types';
import {
  describe_unresolved_destination,
  resolve_destination_library,
} from '@/services/restore/restore-target';

/** Per-run state deciding which library each entry is written to. */
export interface EntryRouting {
  readonly cross_site: boolean;
  readonly target_libraries: readonly SharePointDocumentLibrary[];
  readonly single_source_library: boolean;
  /** Memoised destination per source library id; undefined means unresolvable. */
  readonly destination_by_source_drive: Map<string, string | undefined>;
}

/**
 * Destination drive for one entry, or undefined when it cannot be placed. Resolution is memoised
 * per source library, so an unresolvable library is reported once rather than once per file it
 * holds.
 */
export function resolve_entry_destination(
  entry: SharePointManifestEntry,
  routing: EntryRouting,
  errors: string[],
): string | undefined {
  if (!routing.cross_site) {
    if (!entry.drive_id) {
      errors.push(`${entry.file_name}: manifest entry records no library; skipped`);
    }
    return entry.drive_id;
  }

  const { destination_by_source_drive, target_libraries, single_source_library } = routing;
  if (destination_by_source_drive.has(entry.drive_id)) {
    return destination_by_source_drive.get(entry.drive_id);
  }

  const destination = resolve_destination_library(
    entry.library_name,
    target_libraries,
    single_source_library,
  )?.drive_id;
  destination_by_source_drive.set(entry.drive_id, destination);
  if (!destination) {
    errors.push(
      describe_unresolved_destination(entry.library_name, target_libraries, single_source_library),
    );
  }
  return destination;
}
