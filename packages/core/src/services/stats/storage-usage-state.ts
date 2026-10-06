import { ConfigError } from '@wisecom/atlas-types';
import type {
  StorageListingCursor,
  StorageListingMode,
  StorageUploadCursor,
  StorageUsageBreakdown,
} from '@wisecom/atlas-types';
import {
  empty_counts,
  type UsageCounts,
  type UsageTally,
} from '@/services/stats/storage-usage-tally';

/** One prefix still to list, and where its listing resumes. */
export interface PendingPrefix {
  readonly prefix: string;
  cursor?: StorageListingCursor | undefined;
  /** Fixed by the first page, so a cursor is never handed to the other kind of listing. */
  mode?: StorageListingMode;
}

/** An incomplete upload being sized one part page at a time. */
export interface PendingUpload {
  readonly key: string;
  readonly upload_id: string;
  bytes: number;
  part_marker?: string | undefined;
}

/** Listing incomplete uploads, then sizing each from its parts, one request per step. */
export interface UploadsPhase {
  /** The upload listing has returned its last page. */
  listed: boolean;
  /** False once uploads or their parts were refused; the upload figures are then incomplete. */
  visible: boolean;
  /** Parts were refused, so later uploads are counted without their bytes. */
  parts_denied: boolean;
  cursor?: StorageUploadCursor | undefined;
  /** Uploads listed but not yet fully sized, in listing order. */
  pending: PendingUpload[];
}

/**
 * Everything a measurement needs to resume without counting anything twice: which phase it is
 * in, where each unfinished listing stops, and what has been counted so far.
 */
export interface UsageState extends UsageTally {
  readonly version: 1;
  readonly tenant_id: string;
  readonly target_id: string;
  readonly breakdown: StorageUsageBreakdown;
  readonly started_at: string;
  mode: StorageListingMode;
  versions_visible: boolean;
  /** The root listing that counts root-level keys and finds the top-level prefixes. */
  discovery: { done: boolean; cursor?: StorageListingCursor };
  prefixes: PendingPrefix[];
  uploads: UploadsPhase;
  requests: number;
}

export interface StateIdentity {
  readonly tenant_id: string;
  readonly target_id: string;
  readonly breakdown: StorageUsageBreakdown;
}

/** A measurement that has not listed anything yet. */
export function fresh_state(identity: StateIdentity, now: Date): UsageState {
  return {
    version: 1,
    ...identity,
    started_at: now.toISOString(),
    mode: 'versions',
    versions_visible: true,
    discovery: { done: false },
    prefixes: [],
    uploads: { listed: false, visible: true, parts_denied: false, pending: [] },
    requests: 0,
    by_workload: {},
    ...(identity.breakdown === 'owner' ? { by_owner: {} } : {}),
  };
}

/** True once every phase has run to its end. */
export function is_complete(state: UsageState): boolean {
  return (
    state.discovery.done &&
    state.prefixes.length === 0 &&
    state.uploads.listed &&
    state.uploads.pending.length === 0
  );
}

export function encode_state(state: UsageState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

/**
 * Restores a measurement from a continuation token.
 *
 * The token is caller input. It is validated field by field, and it must belong to the same
 * tenant, target and breakdown: resuming a primary run against a replica would add two buckets
 * together and report the sum as either.
 */
export function decode_state(token: string, identity: StateIdentity): UsageState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw invalid('it is not a storage usage continuation token');
  }
  if (!is_record(parsed) || parsed['version'] !== 1) throw invalid('unsupported token version');
  for (const field of ['tenant_id', 'target_id', 'breakdown'] as const) {
    if (parsed[field] !== identity[field]) {
      throw invalid(`it was issued for a different ${field.replace('_id', '')}`);
    }
  }
  const state = parsed as unknown as UsageState;
  if (
    typeof state.started_at !== 'string' ||
    (state.mode !== 'versions' && state.mode !== 'current') ||
    typeof state.versions_visible !== 'boolean' ||
    !is_count(state.requests) ||
    !is_phase(state.discovery) ||
    !is_uploads_phase(state.uploads) ||
    !Array.isArray(state.prefixes) ||
    !state.prefixes.every(
      (entry) =>
        is_record(entry) &&
        typeof entry.prefix === 'string' &&
        is_cursor(entry.cursor) &&
        (entry.mode === undefined || entry.mode === 'versions' || entry.mode === 'current'),
    ) ||
    !is_counts_map(state.by_workload) ||
    (identity.breakdown === 'owner' ? !is_counts_map(state.by_owner) : state.by_owner !== undefined)
  ) {
    throw invalid('it is malformed');
  }
  return state;
}

function invalid(reason: string): ConfigError {
  return new ConfigError(`continuationToken cannot resume this measurement: ${reason}.`);
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function is_count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function is_cursor(value: unknown): boolean {
  return (
    value === undefined ||
    (is_record(value) && Object.values(value).every((v) => typeof v === 'string'))
  );
}

function is_phase(value: unknown): value is { done: boolean; cursor?: unknown } {
  return is_record(value) && typeof value['done'] === 'boolean' && is_cursor(value['cursor']);
}

function is_uploads_phase(value: unknown): value is UploadsPhase {
  return (
    is_record(value) &&
    typeof value['listed'] === 'boolean' &&
    typeof value['visible'] === 'boolean' &&
    typeof value['parts_denied'] === 'boolean' &&
    is_cursor(value['cursor']) &&
    Array.isArray(value['pending']) &&
    value['pending'].every(
      (upload) =>
        is_record(upload) &&
        typeof upload['key'] === 'string' &&
        typeof upload['upload_id'] === 'string' &&
        is_count(upload['bytes']) &&
        (upload['part_marker'] === undefined || typeof upload['part_marker'] === 'string'),
    )
  );
}

function is_counts_map(value: unknown): value is Record<string, UsageCounts> {
  const fields = Object.keys(empty_counts());
  return (
    is_record(value) &&
    Object.values(value).every(
      (counts) =>
        is_record(counts) &&
        Object.keys(counts).length === fields.length &&
        fields.every((field) => is_count(counts[field])),
    )
  );
}
