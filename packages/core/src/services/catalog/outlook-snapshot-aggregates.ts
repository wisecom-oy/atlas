import { createHash } from 'node:crypto';
import {
  HASHED_OBJECT_ID_LENGTH,
  type Manifest,
  type ManifestEntry,
  type OutlookSnapshotAggregates,
  type SnapshotFolderTotals,
} from '@wisecom/atlas-types';
import { is_json_record } from '@/services/shared/stored-json-reader';
import { stored_count } from '@/services/shared/snapshot-summary-layout';

const HASHED_ID_PATTERN = /^[A-Za-z0-9_-]*$/;
/** The folder `stats -m` reports for an entry that names none. */
const UNKNOWN_FOLDER = 'unknown';

interface AttachmentTotals {
  readonly count: number;
  readonly size: number;
}

interface FolderAccumulator {
  message_count: number;
  total_size_bytes: number;
  attachment_count: number;
  attachment_size_bytes: number;
}

/**
 * Hashes one Graph object ID to the 16 characters a summary row keeps. 96 bits leave the chance of
 * two IDs of one mailbox colliding, and so of a wrong merged count, far below any real risk.
 */
export function hash_object_id(object_id: string): string {
  return createHash('sha256')
    .update(object_id, 'utf8')
    .digest()
    .subarray(0, 12)
    .toString('base64url');
}

/**
 * Builds the per-snapshot figures a summary row keeps, from the manifest in memory at save time.
 * Every total is accumulated the way `stats-aggregator` accumulates it, so sums over rows match
 * sums over manifests (#726).
 */
export function build_outlook_aggregates(manifest: Manifest): OutlookSnapshotAggregates {
  const folders = new Map<string, FolderAccumulator>();
  let entry_size_bytes = 0;
  let attachment_count = 0;
  let attachment_size_bytes = 0;
  for (const entry of manifest.entries) {
    const attached = attachment_totals(entry);
    const entry_total = entry.size_bytes + attached.size;
    entry_size_bytes += entry_total;
    attachment_count += attached.count;
    attachment_size_bytes += attached.size;
    add_entry_to_folder(folders, entry.folder_id ?? UNKNOWN_FOLDER, entry_total, attached);
  }
  return {
    entry_size_bytes,
    attachment_count,
    attachment_size_bytes,
    folders: folder_totals(folders),
    object_ids: join_hashed_ids(manifest.entries.map((entry) => entry.object_id)),
    removed_ids: join_hashed_ids(manifest.removed_object_ids ?? []),
  };
}

/**
 * Reads a stored row's aggregates. Undefined when the row has none (written before #726), and null
 * when they are malformed; the reader then decrypts the manifest rather than trust the row.
 */
export function parse_outlook_aggregates(
  value: unknown,
): OutlookSnapshotAggregates | undefined | null {
  if (value === undefined) return undefined;
  if (!is_json_record(value)) return null;
  const folders = parse_folder_totals(value.folders);
  const entry_size_bytes = stored_count(value, 'entry_size_bytes');
  const attachment_count = stored_count(value, 'attachment_count');
  const attachment_size_bytes = stored_count(value, 'attachment_size_bytes');
  if (
    folders === undefined ||
    entry_size_bytes === undefined ||
    attachment_count === undefined ||
    attachment_size_bytes === undefined ||
    !is_hashed_ids(value.object_ids) ||
    !is_hashed_ids(value.removed_ids)
  ) {
    return null;
  }
  return {
    entry_size_bytes,
    attachment_count,
    attachment_size_bytes,
    folders,
    object_ids: value.object_ids,
    removed_ids: value.removed_ids,
  };
}

function attachment_totals(entry: ManifestEntry): AttachmentTotals {
  let count = 0;
  let size = 0;
  for (const attachment of entry.attachments ?? []) {
    count += 1;
    size += attachment.size_bytes;
  }
  return { count, size };
}

function add_entry_to_folder(
  folders: Map<string, FolderAccumulator>,
  folder_id: string,
  entry_total: number,
  attached: AttachmentTotals,
): void {
  const folder = folders.get(folder_id) ?? {
    message_count: 0,
    total_size_bytes: 0,
    attachment_count: 0,
    attachment_size_bytes: 0,
  };
  folder.message_count += 1;
  folder.total_size_bytes += entry_total;
  folder.attachment_count += attached.count;
  folder.attachment_size_bytes += attached.size;
  folders.set(folder_id, folder);
}

function folder_totals(folders: Map<string, FolderAccumulator>): SnapshotFolderTotals[] {
  return [...folders]
    .map(([folder_id, totals]) => ({ folder_id, ...totals }))
    .sort((a, b) => a.folder_id.localeCompare(b.folder_id));
}

/** Hashes each distinct ID once and concatenates the 16-character results. */
export function join_hashed_ids(object_ids: readonly string[]): string {
  return [...new Set(object_ids)].map(hash_object_id).join('');
}

function is_hashed_ids(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length % HASHED_OBJECT_ID_LENGTH === 0 &&
    HASHED_ID_PATTERN.test(value)
  );
}

function parse_folder_totals(value: unknown): SnapshotFolderTotals[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const folders: SnapshotFolderTotals[] = [];
  for (const item of value) {
    const folder = parse_folder_total(item);
    if (folder === undefined) return undefined;
    folders.push(folder);
  }
  return folders;
}

function parse_folder_total(item: unknown): SnapshotFolderTotals | undefined {
  if (!is_json_record(item) || typeof item.folder_id !== 'string') return undefined;
  const message_count = stored_count(item, 'message_count');
  const total_size_bytes = stored_count(item, 'total_size_bytes');
  const attachment_count = stored_count(item, 'attachment_count');
  const attachment_size_bytes = stored_count(item, 'attachment_size_bytes');
  if (
    message_count === undefined ||
    total_size_bytes === undefined ||
    attachment_count === undefined ||
    attachment_size_bytes === undefined
  ) {
    return undefined;
  }
  return {
    folder_id: item.folder_id,
    message_count,
    total_size_bytes,
    attachment_count,
    attachment_size_bytes,
  };
}
