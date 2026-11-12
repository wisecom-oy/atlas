import type { SnapshotSummary } from '@wisecom/atlas-types';
import { is_json_record } from '@/services/shared/stored-json-reader';
import {
  stored_count,
  type SnapshotSummaryLayout,
} from '@/services/shared/snapshot-summary-layout';

/** Format of the stored summary object. A reader treats any other version as absent. */
export const SNAPSHOT_SUMMARY_FORMAT_VERSION = 1;

/** Serialises an owner's summaries as the stored document, before encryption. */
export function serialize_snapshot_summaries<T extends SnapshotSummary>(
  owner_id: string,
  summaries: readonly T[],
): Buffer {
  const document = {
    format_version: SNAPSHOT_SUMMARY_FORMAT_VERSION,
    owner_id,
    updated_at: new Date().toISOString(),
    snapshots: summaries,
  };
  return Buffer.from(JSON.stringify(document));
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
  if (!is_json_record(value)) return undefined;
  if (value.format_version !== SNAPSHOT_SUMMARY_FORMAT_VERSION) return undefined;
  if (value.owner_id !== owner_id || !Array.isArray(value.snapshots)) return undefined;
  return value.snapshots.flatMap((row: unknown) => {
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
