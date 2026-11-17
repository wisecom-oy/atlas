import type { DriveEntryKind } from '@wisecom/atlas-types';

/** The fields that say what a manifest entry records. */
interface KindedEntry {
  readonly kind?: DriveEntryKind | undefined;
  readonly change_type: string;
}

/**
 * What an entry records. Entries written before folder metadata was captured carry no kind, and
 * every one of them is a file.
 */
export function entry_kind(entry: Pick<KindedEntry, 'kind'>): DriveEntryKind {
  return entry.kind ?? 'file';
}

/**
 * Whether the entry is a file: the only kind with stored content. Restore of content, save,
 * verify, file counts and rename checks all read files only, and they all ask here, so a folder
 * entry can never be mistaken for a file with a missing blob.
 */
export function is_file_entry(entry: Pick<KindedEntry, 'kind'>): boolean {
  return entry_kind(entry) === 'file';
}

/**
 * Whether the entry recorded new content for a file, and so starts a row in the file's version
 * history. A `permissions_changed` entry reuses the previous blob, so its row would repeat the
 * version before it.
 */
export function records_file_content(entry: KindedEntry): boolean {
  return is_file_entry(entry) && entry.change_type !== 'permissions_changed';
}

/** How many entries are files, for the `total_files` a manifest reports. */
export function count_file_entries(entries: readonly Pick<KindedEntry, 'kind'>[]): number {
  return entries.filter((entry) => is_file_entry(entry)).length;
}
