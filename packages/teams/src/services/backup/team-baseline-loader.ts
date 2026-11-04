import {
  UnreadableContentError,
  type FailedItemLedger,
  type TeamsDeltaCursor,
  type TeamsDeltaCursorRepository,
  type TeamsManifestRepository,
  type TeamsSnapshotManifest,
  type TenantContext,
} from '@wisecom/atlas-types';

/** The ports a run reads its starting state through. */
export interface BaselinePorts {
  readonly manifests: TeamsManifestRepository;
  readonly cursors: TeamsDeltaCursorRepository;
}

/** The state a run starts from: the latest readable snapshot and the cursor read against it. */
export interface TeamsBaseline {
  readonly previous: TeamsSnapshotManifest | undefined;
  /**
   * The stored cursor, only when it names the latest readable snapshot. Otherwise undefined, and
   * the run reads every channel in full.
   */
  readonly cursor: TeamsDeltaCursor | undefined;
  /**
   * Failed roots from the stored cursor. Kept even when the cursor is not usable, so a root still
   * pending keeps the run unhealthy.
   */
  readonly failed_roots: FailedItemLedger;
  readonly errors: string[];
  readonly warnings: string[];
}

/**
 * Loads the latest readable snapshot and the cursor for a team. An unreadable cursor or newer
 * manifest is reported rather than silently treated as absent.
 */
export async function load_team_baseline(
  ctx: TenantContext,
  ports: BaselinePorts,
  team_id: string,
): Promise<TeamsBaseline> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stored = await load_stored_cursor(ctx, ports.cursors, team_id, warnings);
  const latest = await ports.manifests.find_latest_by_team(ctx, team_id);
  for (const key of latest.unreadable_keys) {
    errors.push(`Snapshot ${key} could not be read; its channels were not compared`);
  }
  if (latest.unreadable_keys.length > 0) {
    warnings.push('The baseline is an older snapshot because a newer one could not be read');
  }
  const cursor = usable_cursor(stored, latest.manifest?.snapshot_id, team_id, warnings);
  return {
    previous: latest.manifest,
    cursor,
    failed_roots: stored?.failed_roots ?? {},
    errors,
    warnings,
  };
}

async function load_stored_cursor(
  ctx: TenantContext,
  cursors: TeamsDeltaCursorRepository,
  team_id: string,
  warnings: string[],
): Promise<TeamsDeltaCursor | undefined> {
  try {
    return await cursors.load(ctx, team_id);
  } catch (err) {
    if (!(err instanceof UnreadableContentError)) throw err;
    warnings.push(
      `The delta cursor for team ${team_id} is unreadable; reading every channel in full`,
    );
    return undefined;
  }
}

/**
 * Returns the cursor only when it was saved against the latest snapshot. A cursor without a
 * snapshot_id (legacy) is never trusted, because there is nothing to compare it against.
 */
function usable_cursor(
  stored: TeamsDeltaCursor | undefined,
  snapshot_id: string | undefined,
  team_id: string,
  warnings: string[],
): TeamsDeltaCursor | undefined {
  if (stored === undefined) {
    return undefined;
  }
  if (stored.snapshot_id !== undefined && stored.snapshot_id === snapshot_id) {
    return stored;
  }
  warnings.push(
    `The delta cursor for team ${team_id} does not match the latest snapshot; reading every channel in full`,
  );
  return undefined;
}
