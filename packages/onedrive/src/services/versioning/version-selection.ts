import type {
  DriveVersionRestoreOptions,
  OneDriveFileVersionIndex,
  OneDriveFileVersionRecord,
} from '@wisecom/atlas-types';
import { resolve_file_id, version_logical_path } from '@/services/versioning/version-reference';

export interface SelectedVersion {
  readonly file_id: string;
  readonly version: OneDriveFileVersionRecord;
  /** Original rooted path of the file, e.g. `/Documents/Report.docx`. */
  readonly original_path: string;
}

export interface VersionSelection {
  readonly selected: SelectedVersion[];
  /** Files in scope that had no restorable version, with the reason. */
  readonly skipped: string[];
}

/**
 * The instant a stored version's content was last modified in Microsoft 365.
 *
 * Rows written by version sync carry `last_modified_at`; rows copied from a
 * manifest entry may not, and then the backup time is the only thing known.
 * A rollback is expressed in service time ("before the attack"), so service
 * time is what the cutoff compares against wherever it exists.
 */
function version_instant(version: OneDriveFileVersionRecord): string {
  return version.last_modified_at ?? version.backup_at;
}

/** A version is restorable only when its bytes were stored and can be verified. */
function has_restorable_blob(version: OneDriveFileVersionRecord): boolean {
  return Boolean(version.storage_key) && Boolean(version.checksum);
}

/**
 * Picks which stored versions to push back, from the owner's whole version index.
 *
 * Three modes, all resolved here so the service stays orchestration only:
 * one exact version, the newest version of one file before a cutoff, or the
 * newest version of every file in scope before a cutoff.
 */
export function select_versions_to_restore(
  indexes: OneDriveFileVersionIndex[],
  options: DriveVersionRestoreOptions,
): VersionSelection {
  if (options.file_ref === undefined && options.before === undefined) {
    throw new Error('Pass a file reference with --version, or --before for a bulk rollback');
  }

  if (options.file_ref !== undefined) {
    return select_for_one_file(indexes, options);
  }
  return select_before_cutoff(indexes, options);
}

/** Single-file mode: an exact `version_id`, or the newest version before a cutoff. */
function select_for_one_file(
  indexes: OneDriveFileVersionIndex[],
  options: DriveVersionRestoreOptions,
): VersionSelection {
  const file_ref = options.file_ref!;
  const file_id = resolve_file_id(indexes, file_ref);
  if (!file_id) {
    throw new Error(`No stored versions found for '${file_ref}'`);
  }
  const versions = indexes.find((idx) => idx.file_id === file_id)?.versions ?? [];

  if (options.version_id !== undefined) {
    const wanted = versions.find((v) => v.version_id === options.version_id);
    if (!wanted) {
      const known = versions
        .map((v) => v.version_id)
        .filter((id): id is string => id !== undefined);
      throw new Error(
        known.length > 0
          ? `Version '${options.version_id}' not stored for '${file_ref}'. Stored: ${known.join(', ')}`
          : `No identified versions stored for '${file_ref}'; only current-state rows`,
      );
    }
    if (!has_restorable_blob(wanted)) {
      throw new Error(
        `Version '${options.version_id}' of '${file_ref}' has no stored content to restore`,
      );
    }
    return {
      selected: [{ file_id, version: wanted, original_path: version_logical_path(wanted) }],
      skipped: [],
    };
  }

  if (options.before === undefined) {
    throw new Error(
      `Pass --version or --before to choose which version of '${file_ref}' to restore`,
    );
  }
  const newest = newest_before(versions, options.before);
  if (!newest) {
    return { selected: [], skipped: [`${file_ref}: no stored version at or before the cutoff`] };
  }
  return {
    selected: [{ file_id, version: newest, original_path: version_logical_path(newest) }],
    skipped: [],
  };
}

/** Bulk mode: the newest pre-cutoff version of every file under the path scope. */
function select_before_cutoff(
  indexes: OneDriveFileVersionIndex[],
  options: DriveVersionRestoreOptions,
): VersionSelection {
  const cutoff = options.before!;
  const prefix = normalize_prefix(options.path_prefix);
  const selected: SelectedVersion[] = [];
  const skipped: string[] = [];

  for (const idx of indexes) {
    const in_scope = idx.versions.filter((v) => path_in_scope(version_logical_path(v), prefix));
    if (in_scope.length === 0) continue;

    const newest = newest_before(in_scope, cutoff);
    if (!newest) {
      // Every version of this file is newer than the cutoff, so Atlas holds
      // nothing from before the event. Naming it matters: an operator must not
      // read a clean run as "every file rolled back".
      const path = version_logical_path(in_scope[in_scope.length - 1]!);
      skipped.push(`${path}: no stored version at or before the cutoff`);
      continue;
    }
    selected.push({
      file_id: idx.file_id,
      version: newest,
      original_path: version_logical_path(newest),
    });
  }

  return { selected, skipped };
}

/** Newest restorable version at or before the cutoff, or undefined when none is. */
function newest_before(
  versions: readonly OneDriveFileVersionRecord[],
  cutoff: Date,
): OneDriveFileVersionRecord | undefined {
  const limit = cutoff.getTime();
  let best: OneDriveFileVersionRecord | undefined;
  let best_time = -Infinity;
  for (const version of versions) {
    if (!has_restorable_blob(version)) continue;
    const time = new Date(version_instant(version)).getTime();
    if (Number.isNaN(time) || time > limit) continue;
    // `>=` keeps the last row at an identical timestamp: Graph timestamps have
    // second precision, and the index is already ordered oldest first.
    if (time >= best_time) {
      best = version;
      best_time = time;
    }
  }
  return best;
}

/** Rooted, NFC-normalized prefix with no trailing slash; undefined means the whole drive. */
function normalize_prefix(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const unified = raw.replace(/\\/g, '/').trim();
  const rooted = unified.startsWith('/') ? unified : `/${unified}`;
  const trimmed = rooted.replace(/\/+$/, '');
  return (trimmed === '' ? '/' : trimmed).normalize('NFC');
}

/** Whether a file path sits at or under the scope prefix. */
function path_in_scope(path: string, prefix: string | undefined): boolean {
  if (prefix === undefined || prefix === '/') return true;
  const normalized = path.normalize('NFC');
  // Segment-boundary match, so `/Docs` never captures `/Docs Archive`.
  return normalized === prefix || normalized.startsWith(`${prefix}/`);
}
