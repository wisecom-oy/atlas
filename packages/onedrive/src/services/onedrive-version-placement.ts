import type { DriveVersionPlacement, OneDriveFileVersionRecord } from '@wisecom/atlas-types';

/** Splits a rooted file path into its parent path and file name. */
export function split_parent_path(path: string): { parent_path: string; file_name: string } {
  const cut = path.lastIndexOf('/');
  if (cut <= 0) return { parent_path: '/', file_name: path.slice(cut + 1) };
  return { parent_path: path.slice(0, cut), file_name: path.slice(cut + 1) };
}

/**
 * Names the file the restored bytes are written to.
 *
 * `in-place` keeps the original name, so the service records a new current
 * version of the same file. `copy` appends the version's own modification
 * time before the extension, which keeps the restored file adjacent to the
 * original in a sorted listing and states which point in time it came from.
 */
export function build_restored_file_name(
  version: OneDriveFileVersionRecord,
  placement: DriveVersionPlacement,
): string {
  if (placement === 'in-place') return version.file_name;

  const stamp = restored_stamp(version);
  const dot = version.file_name.lastIndexOf('.');
  // A leading dot is the whole name of a dotfile, not an extension.
  if (dot <= 0) return `${version.file_name} (restored ${stamp})`;
  return `${version.file_name.slice(0, dot)} (restored ${stamp})${version.file_name.slice(dot)}`;
}

/**
 * Filename-safe instant for the restored copy, in UTC.
 *
 * Colons are legal in OneDrive but break the file on export to Windows, and
 * Atlas exports archives, so they never enter a name it creates.
 */
function restored_stamp(version: OneDriveFileVersionRecord): string {
  const raw = version.last_modified_at ?? version.backup_at;
  const parsed = new Date(raw);
  const iso = Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
  return iso.replace(/\.\d+Z$/, 'Z').replace(/[:]/g, '-');
}
