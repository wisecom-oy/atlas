import type { DriveFileVersionIndexView, DriveFileVersionRecord } from '@/drive-ports';
import { join_drive_path } from '@/shared/logical-path';

/** Maps a CLI file reference (Graph item id or rooted path) to a file id, if known. */
export function resolve_file_id(
  indexes: readonly DriveFileVersionIndexView[],
  file_ref: string,
): string | undefined {
  const trimmed = file_ref.trim();
  if (!looks_like_path(trimmed)) {
    if (indexes.some((idx) => idx.file_id === trimmed)) return trimmed;
    return match_by_file_name(indexes, trimmed);
  }
  return match_by_path(indexes, normalize_path_ref(trimmed));
}

/**
 * Matches a rooted path against every indexed version, and raises when it maps to more than one
 * file, the same way a bare name does (issue #300).
 *
 * One path can belong to two file ids: the path is reconstructed per version record, so a file
 * deleted and recreated at the same path, or a path reused after a move, leaves two drive items
 * behind it. Returning whichever the iteration reached first restored a version of an
 * arbitrarily chosen file.
 */
function match_by_path(
  indexes: readonly DriveFileVersionIndexView[],
  want: string,
): string | undefined {
  const matches = new Set<string>();
  for (const idx of indexes) {
    for (const v of idx.versions) {
      if (normalize_path_ref(version_logical_path(v)) === want) matches.add(idx.file_id);
    }
  }
  if (matches.size > 1) {
    const ids = [...matches].sort().join(', ');
    throw new Error(
      `'${want}' matches ${matches.size} files: ${ids}. ` + 'Pass the file id of the one you mean.',
    );
  }
  return [...matches][0];
}

/**
 * Matches a bare filename against every indexed version of the owning segment's files.
 * Throws with the candidate paths when the name maps to more than one file.
 */
function match_by_file_name(
  indexes: readonly DriveFileVersionIndexView[],
  file_name: string,
): string | undefined {
  const matches = new Map<string, string>();
  for (const idx of indexes) {
    for (const v of idx.versions) {
      if (v.file_name === file_name) matches.set(idx.file_id, version_logical_path(v));
    }
  }
  if (matches.size > 1) {
    const candidates = [...new Set(matches.values())].sort().join(', ');
    throw new Error(
      `'${file_name}' matches ${matches.size} files: ${candidates}. Pass a full path instead.`,
    );
  }
  return [...matches.keys()][0];
}

/** Paths contain a slash; Graph ids do not. */
function looks_like_path(ref: string): boolean {
  return ref.includes('/') || ref.includes('\\');
}

/** NFC-normalized path string comparable to stored manifest/index paths. */
function normalize_path_ref(raw: string): string {
  const unified = raw.replace(/\\/g, '/').trim();
  const with_slash = unified.startsWith('/') ? unified : `/${unified}`;
  return with_slash.normalize('NFC');
}

/** Rooted logical path of one version record, e.g. `/Documents/Report.docx`. */
export function version_logical_path(v: DriveFileVersionRecord): string {
  return join_drive_path(v.parent_path, v.file_name);
}
