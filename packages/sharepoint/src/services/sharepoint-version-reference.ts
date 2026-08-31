import type { SharePointFileVersionIndex, SharePointFileVersionRecord } from '@wisecom/atlas-types';

/** Maps a CLI file reference (Graph item id or rooted path) to a file id, if known. */
export function resolve_file_id(
  indexes: SharePointFileVersionIndex[],
  file_ref: string,
): string | undefined {
  const trimmed = file_ref.trim();
  if (!looks_like_path(trimmed)) {
    if (indexes.some((idx) => idx.file_id === trimmed)) return trimmed;
    return match_by_file_name(indexes, trimmed);
  }
  const want = normalize_path_ref(trimmed);
  for (const idx of indexes) {
    for (const v of idx.versions) {
      if (normalize_path_ref(version_logical_path(v)) === want) return idx.file_id;
    }
  }
  return undefined;
}

/**
 * Matches a bare filename against every indexed version of the site's files.
 * Throws with the candidate paths when the name maps to more than one file.
 */
function match_by_file_name(
  indexes: SharePointFileVersionIndex[],
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

export function version_logical_path(v: SharePointFileVersionRecord): string {
  const base = v.parent_path.replace(/\/+$/, '') || '';
  if (base === '' || base === '/') return `/${v.file_name}`;
  return `${base}/${v.file_name}`;
}
