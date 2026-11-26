/**
 * The delta cursor fields keyed by drive item id. They grow with the drive, so a large cursor
 * stores them in parts (#920); every other field stays in the head.
 */
export const DRIVE_CURSOR_ITEM_MAP_FIELDS: readonly string[] = Object.freeze([
  'previous_path_by_file_id',
  'previous_name_by_file_id',
  'previous_etag_by_file_id',
  'previous_kind_by_file_id',
  'permission_digest_by_item_id',
  'folder_color_by_item_id',
  'version_watermark_by_file_id',
  'pending_versions_by_file_id',
  'failed_items',
]);

/** Item maps by field name, each keyed by drive item id. */
export type CursorItemMaps = Record<string, Record<string, unknown>>;

/** A cursor split into what the head stores and what the parts store. */
export interface SplitCursor {
  readonly head_fields: Record<string, unknown>;
  readonly item_maps: CursorItemMaps;
}

/**
 * Splits a cursor into its item maps and everything else. A field that is absent stays absent:
 * several of them mean "written before this was tracked" when missing, which `{}` would not.
 */
export function split_cursor_fields(cursor: object): SplitCursor {
  const head_fields: Record<string, unknown> = {};
  const item_maps: CursorItemMaps = {};
  for (const [field, value] of Object.entries(cursor)) {
    if (DRIVE_CURSOR_ITEM_MAP_FIELDS.includes(field) && is_record(value)) {
      item_maps[field] = value;
    } else {
      head_fields[field] = value;
    }
  }
  return { head_fields, item_maps };
}

/** The number of items the largest map tracks, which is roughly the drive's item count. */
export function count_tracked_items(item_maps: CursorItemMaps): number {
  let largest = 0;
  for (const map of Object.values(item_maps)) largest = Math.max(largest, Object.keys(map).length);
  return largest;
}

/**
 * Picks a power-of-two bucket count that puts about `items_per_part` items in each bucket.
 *
 * The previous count is kept while each of its buckets holds between a quarter and twice the
 * target, because changing the count moves almost every item to another bucket and rewrites every
 * part. A drive that hovers around a boundary therefore does not rewrite its cursor on each run.
 */
export function choose_bucket_count(
  items: number,
  items_per_part: number,
  previous_count?: number,
): number {
  if (previous_count !== undefined && is_power_of_two(previous_count)) {
    const per_bucket = items / previous_count;
    if (per_bucket >= items_per_part / 4 && per_bucket <= items_per_part * 2) return previous_count;
  }
  let count = 1;
  while (count * items_per_part < items) count *= 2;
  return count;
}

/** The bucket an item id falls in: FNV-1a over the id, masked to the power-of-two count. */
export function bucket_of(item_id: string, bucket_count: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < item_id.length; i++) {
    hash ^= item_id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) & (bucket_count - 1);
}

/** For each field, the ids of each bucket, sorted so a bucket serialises the same way every run. */
export type BucketedItemIds = ReadonlyMap<string, readonly string[][]>;

/**
 * Sorts every item id into its bucket, one list per field and bucket. Holds references to the ids
 * the maps already hold, not copies of the maps, so the cursor is never duplicated in memory.
 */
export function index_item_ids_by_bucket(
  item_maps: CursorItemMaps,
  bucket_count: number,
): BucketedItemIds {
  const index = new Map<string, string[][]>();
  for (const [field, map] of Object.entries(item_maps)) {
    const buckets = Array.from({ length: bucket_count }, (): string[] => []);
    for (const item_id of Object.keys(map))
      buckets[bucket_of(item_id, bucket_count)]!.push(item_id);
    for (const bucket of buckets) bucket.sort();
    index.set(field, buckets);
  }
  return index;
}

/** Builds one bucket's slice of every item map, fields in their fixed order, ids sorted. */
export function build_bucket_item_maps(
  item_maps: CursorItemMaps,
  ids: BucketedItemIds,
  bucket: number,
): CursorItemMaps {
  const slice: CursorItemMaps = {};
  for (const field of DRIVE_CURSOR_ITEM_MAP_FIELDS) {
    const map = item_maps[field];
    const bucket_ids = ids.get(field)?.[bucket];
    if (map === undefined || bucket_ids === undefined) continue;
    const field_slice: Record<string, unknown> = {};
    for (const item_id of bucket_ids) field_slice[item_id] = map[item_id];
    slice[field] = field_slice;
  }
  return slice;
}

function is_power_of_two(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
