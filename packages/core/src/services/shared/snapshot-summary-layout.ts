import type { SnapshotSummary, TenantContext } from '@wisecom/atlas-types';

/**
 * How one workload keeps its per-owner snapshot summary index (#625): where the summary and the
 * manifests live, how a manifest is read and summarised, and how a stored row's workload fields
 * are read back. Outlook, OneDrive and SharePoint differ only in these.
 */
export interface SnapshotSummaryLayout<TManifest, TSummary extends SnapshotSummary> {
  /** Workload name for operator-facing messages, e.g. `OneDrive`. */
  readonly label: string;
  readonly summary_key: (owner_id: string) => string;
  /** Prefix listing every manifest of one owner. */
  readonly manifest_prefix: (owner_id: string) => string;
  /** Prefix listing every manifest of the workload, `{root}{owner_id}/{snapshot_id}.json`. */
  readonly manifest_root_prefix: string;
  readonly manifest_key: (owner_id: string, snapshot_id: string) => string;
  /**
   * Reads one manifest the way the workload's listings do. Undefined when absent; raises
   * `UnreadableContentError` when it fails to decrypt, parse, or identify as its key.
   */
  readonly read_manifest: (ctx: TenantContext, key: string) => Promise<TManifest | undefined>;
  /** Builds the row recorded for a manifest stored at `manifest_key`. */
  readonly summarize: (manifest: TManifest, manifest_key: string) => TSummary;
  /**
   * Reads a stored row's workload fields on top of its validated common fields; undefined when
   * they are malformed, which makes the reader decrypt that manifest instead.
   */
  readonly parse_details: (
    row: Readonly<Record<string, unknown>>,
    common: SnapshotSummary,
  ) => TSummary | undefined;
  /**
   * Whether a parsed row carries every field the workload's readers now need. A row that does not
   * (written before the field existed) is reconciled as rowless: its manifest is decrypted, and the
   * next write replaces the row (#726). Absent means every parsed row is current.
   */
  readonly is_current?: (summary: TSummary) => boolean;
}

/** Reads an optional string field of a stored row; `null` when present with another type. */
export function optional_string(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined | null {
  const value = row[field];
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

/** Reads a non-negative count field of a stored row; undefined when it is not one. */
export function stored_count(
  row: Readonly<Record<string, unknown>>,
  field: string,
): number | undefined {
  const value = row[field];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Orders summaries newest first by `created_at`. */
export function newest_summaries_first<T extends SnapshotSummary>(summaries: T[]): T[] {
  return summaries.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
}
