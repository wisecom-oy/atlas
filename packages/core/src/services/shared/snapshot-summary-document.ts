import type { SnapshotSummary } from '@wisecom/atlas-types';
import { is_json_record } from '@/services/shared/stored-json-reader';
import {
  stored_count,
  type SnapshotSummaryLayout,
} from '@/services/shared/snapshot-summary-layout';

/** Format of the stored summary object. A reader treats any other version as absent. */
export const SNAPSHOT_SUMMARY_FORMAT_VERSION = 1;

/** The stored summary document of one owner, before serialisation and encryption. */
export interface SnapshotSummaryDocument<T extends SnapshotSummary> {
  readonly format_version: number;
  readonly owner_id: string;
  readonly updated_at: string;
  readonly snapshots: readonly T[];
}

/** Builds the stored document that holds an owner's summaries. */
export function build_snapshot_summary_document<T extends SnapshotSummary>(
  owner_id: string,
  summaries: readonly T[],
): SnapshotSummaryDocument<T> {
  return {
    format_version: SNAPSHOT_SUMMARY_FORMAT_VERSION,
    owner_id,
    updated_at: new Date().toISOString(),
    snapshots: summaries,
  };
}

/**
 * The document check of a parsed summary, shared by reader and writer: raises unless it is a
 * summary this build wrote for `owner_id`, and returns its stored rows unparsed. The reader treats
 * a document that fails it as absent; the writer refuses to store one.
 *
 * Rows are not checked here. The reader drops a malformed row and decrypts that manifest instead,
 * which is the same answer the manifest itself gives, so a row never makes the document unusable.
 */
export function require_snapshot_summary_document(
  owner_id: string,
  value: unknown,
): readonly unknown[] {
  if (!is_json_record(value)) throw new Error('it is not a JSON object');
  if (value.format_version !== SNAPSHOT_SUMMARY_FORMAT_VERSION) {
    throw new Error(`its format_version is not ${SNAPSHOT_SUMMARY_FORMAT_VERSION}`);
  }
  if (value.owner_id !== owner_id) throw new Error(`it does not name ${owner_id} as its owner`);
  if (!Array.isArray(value.snapshots)) throw new Error('it holds no snapshots array');
  return value.snapshots as readonly unknown[];
}

/**
 * Reads the rows of a decrypted summary document, or undefined when the document is not one this
 * build wrote for `owner_id`.
 *
 * The envelope binds ciphertext to its directory, not its file name, so the owner is checked in
 * the body as well (issue #622). A row is kept only when its `manifest_key` is the key its own
 * owner and snapshot build: a row naming another key would let a list answer for a manifest that
 * is not this owner's. A malformed row is dropped, and the reader decrypts its manifest instead.
 */
export function parse_snapshot_summaries<TManifest, TSummary extends SnapshotSummary>(
  layout: SnapshotSummaryLayout<TManifest, TSummary>,
  owner_id: string,
  value: unknown,
): TSummary[] | undefined {
  let rows: readonly unknown[];
  try {
    rows = require_snapshot_summary_document(owner_id, value);
  } catch {
    return undefined;
  }
  return rows.flatMap((row: unknown) => {
    const summary = parse_row(layout, owner_id, row);
    return summary ? [summary] : [];
  });
}

/** Validates one stored row's common fields, then hands it to the workload's parser. */
function parse_row<TManifest, TSummary extends SnapshotSummary>(
  layout: SnapshotSummaryLayout<TManifest, TSummary>,
  owner_id: string,
  row: unknown,
): TSummary | undefined {
  if (!is_json_record(row)) return undefined;
  const { snapshot_id, manifest_key, created_at } = row;
  if (typeof snapshot_id !== 'string' || typeof manifest_key !== 'string') return undefined;
  if (manifest_key !== expected_manifest_key(layout, owner_id, snapshot_id)) return undefined;
  if (typeof created_at !== 'string' || Number.isNaN(Date.parse(created_at))) return undefined;
  const entry_count = stored_count(row, 'entry_count');
  const total_size_bytes = stored_count(row, 'total_size_bytes');
  if (entry_count === undefined || total_size_bytes === undefined) return undefined;
  const common: SnapshotSummary = {
    snapshot_id,
    created_at: new Date(created_at),
    manifest_key,
    entry_count,
    total_size_bytes,
  };
  return layout.parse_details(row, common);
}

/** The key a row's owner and snapshot build; undefined when the layout rejects them. */
function expected_manifest_key<TManifest, TSummary extends SnapshotSummary>(
  layout: SnapshotSummaryLayout<TManifest, TSummary>,
  owner_id: string,
  snapshot_id: string,
): string | undefined {
  try {
    return layout.manifest_key(owner_id, snapshot_id);
  } catch {
    return undefined;
  }
}
