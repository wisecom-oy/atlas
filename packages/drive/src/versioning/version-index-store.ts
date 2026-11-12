import type { TenantContext } from '@wisecom/atlas-types';
import { UnreadableObjectsError, UnsupportedFormatVersionError } from '@wisecom/atlas-types';
import { read_each_readable } from '@wisecom/atlas-core/services/shared/readable-object-listing';
import { is_json_record } from '@wisecom/atlas-core/services/shared/stored-json-reader';
import { write_encrypted_json } from '@wisecom/atlas-core/services/shared/stored-json-writer';
import { is_absent_object_error } from '@wisecom/atlas-core/services/shared/absent-object';
import { append_all } from '@wisecom/atlas-core/utils/append-all';
import type { DriveFileVersionIndexView, DriveFileVersionRecord } from '@/drive-ports';

/**
 * Parallel GETs per index read. The objects are small and independent, so the scan is
 * latency-bound; serial awaits leave the process idle. Kept modest because a read can coincide
 * with a backup saturating the same S3 client.
 */
const INDEX_READ_CONCURRENCY = 8;

/** Every file's version rows merged across index objects, and the objects that could not be read. */
export interface MergedVersionIndexes {
  readonly versions_by_file: Map<string, DriveFileVersionRecord[]>;
  readonly unreadable_keys: string[];
}

/**
 * Reads every index object at `keys` and merges the rows per file, oldest first with repeated
 * historical version ids dropped.
 *
 * A fetch failure fails the read: an unread object is indistinguishable from a file with no
 * history, and that value decides version dedup, restore selection and verification. An object
 * that fails to decrypt, parse or carry index rows is left out and its key returned, so a caller
 * can report it instead of presenting the run's versions as never recorded (issue #631).
 */
export async function read_merged_version_indexes(
  ctx: TenantContext,
  keys: readonly string[],
): Promise<MergedVersionIndexes> {
  const listing = await read_each_readable(
    keys,
    (key) => read_version_index_object(ctx, key),
    INDEX_READ_CONCURRENCY,
  );
  const versions_by_file = new Map<string, DriveFileVersionRecord[]>();
  for (const indexes of listing.items) {
    for (const idx of indexes) {
      const rows = versions_by_file.get(idx.file_id);
      if (rows) append_all(rows, idx.versions);
      else versions_by_file.set(idx.file_id, [...idx.versions]);
    }
  }
  for (const rows of versions_by_file.values()) sort_and_deduplicate_versions(rows);
  return { versions_by_file, unreadable_keys: listing.unreadable_keys };
}

/**
 * Downloads one index object and returns its per-file indexes. Both the per-run payload and the
 * legacy per-file index written before issue #161 are accepted, so history recorded by older
 * Atlas versions stays visible until those objects are purged.
 */
export async function read_version_index_object(
  ctx: TenantContext,
  key: string,
): Promise<DriveFileVersionIndexView[]> {
  const payload = await ctx.storage.get(key);
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.decrypt(payload, key).toString('utf-8')) as unknown;
  } catch (err) {
    // Written by a newer Atlas: intact, so it must fail the read, never be skipped as damage.
    if (err instanceof UnsupportedFormatVersionError) throw err;
    throw new UnreadableObjectsError(`The version index does not decrypt or parse`, [key], {
      cause: err,
    });
  }
  return require_version_indexes(parsed, key);
}

/**
 * The shape check of a parsed index object, shared by reader and writer. Returns its per-file
 * indexes, from the per-run payload or the legacy per-file form.
 */
export function require_version_indexes(parsed: unknown, key: string): DriveFileVersionIndexView[] {
  const indexes = is_json_record(parsed) && 'indexes' in parsed ? parsed.indexes : [parsed];
  if (!Array.isArray(indexes) || !indexes.every(is_file_version_index)) {
    throw new UnreadableObjectsError(`The version index holds no version index rows`, [key]);
  }
  return indexes;
}

/** One run's version index object as stored. */
export interface RunVersionIndexWrite {
  readonly key: string;
  /** Provider name for operator-facing messages, e.g. `OneDrive`. */
  readonly provider: string;
  /** The stored body: the owning segment, the snapshot id, and `indexes`. */
  readonly payload: unknown;
}

/**
 * Encrypts and uploads one run's index object. The write is create-only, refused when
 * {@link require_version_indexes} would reject the body, and read back once it lands.
 */
export async function write_run_version_index(
  ctx: TenantContext,
  run_index: RunVersionIndexWrite,
): Promise<void> {
  await write_encrypted_json(
    ctx,
    {
      key: run_index.key,
      label: `${run_index.provider} version index`,
      reader_check: require_version_indexes,
      write: 'create_only',
      confirm_read_back: true,
    },
    run_index.payload,
  );
}

/** Whether a parsed value is one file's version index: a file id and a list of rows. */
function is_file_version_index(value: unknown): value is DriveFileVersionIndexView {
  return (
    is_json_record(value) &&
    typeof value.file_id === 'string' &&
    Array.isArray(value.versions) &&
    value.versions.every(is_json_record)
  );
}

/** Orders rows oldest first and drops repeated historical version ids. */
function sort_and_deduplicate_versions(versions: DriveFileVersionRecord[]): void {
  versions.sort((a, b) => (a.backup_at < b.backup_at ? -1 : a.backup_at > b.backup_at ? 1 : 0));
  const seen_version_ids = new Set<string>();
  let write_index = 0;
  for (const version of versions) {
    if (version.version_id && seen_version_ids.has(version.version_id)) continue;
    if (version.version_id) seen_version_ids.add(version.version_id);
    versions[write_index++] = version;
  }
  versions.length = write_index;
}

/** Same as {@link read_version_index_object}, resolving `undefined` when the object is absent. */
export async function read_version_index_object_if_present(
  ctx: TenantContext,
  key: string,
): Promise<DriveFileVersionIndexView[] | undefined> {
  try {
    return await read_version_index_object(ctx, key);
  } catch (err) {
    if (is_absent_object_error(err)) return undefined;
    throw err;
  }
}
