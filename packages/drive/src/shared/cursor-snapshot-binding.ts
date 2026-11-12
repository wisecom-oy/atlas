import type { LatestReadableManifest, TenantContext } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type { DriveStorageKeys } from '@/shared/storage-keys';

/**
 * The snapshot a drive delta cursor was saved with: its id, `null` when the owning segment had no
 * snapshot at all, and absent on a cursor written before the binding existed.
 */
export interface SnapshotBoundCursor {
  readonly snapshot_id?: string | null;
}

/**
 * Says why a stored cursor has outlived the snapshot it was saved with, so its delta links, change
 * tracking, failed-item ledger and version watermarks must not be resumed. Undefined when the
 * cursor may be resumed, or when none is stored.
 *
 * A cursor says where the last run stopped reading Graph. That is only meaningful on top of the
 * snapshot that run wrote, or left as the newest when it changed nothing. Once that manifest is
 * gone, whether deleted with `delete -s`, moved aside by quarantine, or missing after a
 * rehydration, resuming would skip every change only that snapshot recorded (issue #725).
 *
 * The test is that the manifest object still exists, which costs one listing. It deliberately does
 * not read the manifests to find the newest readable one, as `cursor_describes_head` callers do
 * for mailboxes: a drive has no head pointer, so that would download every manifest of the owning
 * segment on every run. Existence is enough because the cursor is rebound whenever a run writes a
 * snapshot. A cursor older than the newest manifest reads some changes twice; it never skips one.
 *
 * A cursor written before the binding existed is trusted while any manifest exists. A cursor bound
 * to no snapshot belongs to a segment whose runs never produced an entry, such as an empty drive,
 * and stays resumable until a manifest appears.
 */
export async function explain_outlived_cursor(
  ctx: TenantContext,
  keys: DriveStorageKeys,
  owner_id: string,
  cursor: SnapshotBoundCursor | undefined,
): Promise<string | undefined> {
  if (cursor === undefined) return undefined;
  const manifest_keys = await ctx.storage.list(keys.manifest_prefix_for(owner_id));
  return describe_outlived_binding(cursor.snapshot_id, manifest_keys, (snapshot_id) =>
    keys.manifest_key(owner_id, snapshot_id),
  );
}

/** Compares a cursor's binding with the manifest keys that exist; see `explain_outlived_cursor`. */
export function describe_outlived_binding(
  binding: string | null | undefined,
  manifest_keys: readonly string[],
  manifest_key_of: (snapshot_id: string) => string,
): string | undefined {
  if (binding === undefined) {
    return manifest_keys.length > 0
      ? undefined
      : 'the delta cursor records no snapshot and no snapshot exists';
  }
  if (binding === null) {
    return manifest_keys.length === 0
      ? undefined
      : 'the delta cursor was saved before the first snapshot existed';
  }
  return manifest_keys.includes(manifest_key_of(binding))
    ? undefined
    : `snapshot ${binding}, which the delta cursor was saved with, no longer exists`;
}

/**
 * Picks the snapshot a run binds its saved cursor to.
 *
 * A run that wrote a manifest binds to it. A run that wrote none leaves the newest snapshot where
 * it was: a resumed cursor already names it, so the binding is carried over without a read.
 * Otherwise (a full run, a cursor written before the binding existed, or no cursor) the newest
 * readable manifest is looked up once, and `null` records that there is none.
 */
export async function resolve_saved_cursor_binding(
  written_snapshot_id: string | undefined,
  resumed_cursor: SnapshotBoundCursor | undefined,
  find_latest_snapshot: () => Promise<LatestReadableManifest<{ readonly snapshot_id: string }>>,
): Promise<string | null> {
  if (written_snapshot_id !== undefined) return written_snapshot_id;
  if (resumed_cursor?.snapshot_id !== undefined) return resumed_cursor.snapshot_id;
  return (await find_latest_snapshot()).manifest?.snapshot_id ?? null;
}

/** The warning a backup reports when it reads in full because its cursor outlived its snapshot. */
export function outlived_cursor_warning(reason: string, unit: 'drive' | 'library'): string {
  return (
    `Not resuming the saved delta links: ${reason}. Reading every ${unit} in full so that ` +
    `nothing the missing snapshot recorded is skipped.`
  );
}

/** How much of the stored cursor a backup run continues from. */
export interface ResumableCursor<C> {
  /**
   * The cursor whose delta links, change tracking and failed-item ledger the run continues.
   * Undefined makes the run read every drive in full, which presents each ledger item again.
   */
  readonly previous_cursor: C | undefined;
  /**
   * The cursor whose version watermarks the run trusts. A forced full run and a changed scope keep
   * them: they record which historical versions Graph already handed over, not where the delta
   * stream stopped, and discarding them would re-download every version of every file (issue
   * #161). A cursor that outlived its snapshot is the exception: nothing says the index rows
   * behind its watermarks survived, so the run seeds them from the version index again.
   */
  readonly watermark_cursor: C | undefined;
  /** Why the run reads in full although the operator did not ask it to; undefined otherwise. */
  readonly outlived_warning: string | undefined;
}

/** Why a run may have to read in full, apart from its cursor having outlived its snapshot. */
export interface FullReadRequest {
  /** `drive` or `library`, for the warning. */
  readonly unit: 'drive' | 'library';
  /** The operator passed `--full`. */
  readonly force_full: boolean;
  /** The run's folder scope differs from the one the cursor was advanced under. */
  readonly scope_changed?: boolean;
}

/**
 * Decides whether a backup run resumes the stored cursor or reads every drive in full, and logs
 * the warning when the reason is a cursor that outlived its snapshot (issue #725).
 */
export async function select_resumable_cursor<C extends SnapshotBoundCursor>(
  ctx: TenantContext,
  keys: DriveStorageKeys,
  owner_id: string,
  stored_cursor: C | undefined,
  request: FullReadRequest,
): Promise<ResumableCursor<C>> {
  const outlived = await explain_outlived_cursor(ctx, keys, owner_id, stored_cursor);
  const outlived_warning =
    outlived === undefined || request.force_full
      ? undefined
      : outlived_cursor_warning(outlived, request.unit);
  if (outlived_warning !== undefined) logger.warn(outlived_warning);
  const read_in_full =
    request.force_full || request.scope_changed === true || outlived !== undefined;
  return {
    previous_cursor: read_in_full ? undefined : stored_cursor,
    watermark_cursor: outlived === undefined ? stored_cursor : undefined,
    outlived_warning,
  };
}
