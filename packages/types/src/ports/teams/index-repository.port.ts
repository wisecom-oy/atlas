import type { TeamsSnapshotIndex } from '@/domain/teams-manifest';
import type { TenantContext } from '@/ports/tenant/context.port';

/** The newest readable index of a team, plus the keys of the indexes it skipped. */
export interface TeamsLatestIndex {
  readonly index: TeamsSnapshotIndex | undefined;
  /** Index keys that could not be decrypted, parsed, or identified as the key they sit under. */
  readonly unreadable_keys: string[];
  /** Index keys written by a newer format version than this build reads. */
  readonly unsupported_keys: string[];
}

/** Every readable index of a team, plus the keys of the indexes that were skipped. */
export interface TeamsSnapshotListing {
  readonly indexes: TeamsSnapshotIndex[];
  readonly unreadable_keys: string[];
  readonly unsupported_keys: string[];
}

/** One team's row of a tenant-wide listing. */
export interface TeamsTeamListing {
  readonly team_id: string;
  readonly listing: TeamsSnapshotListing;
}

/**
 * Snapshot indexes, stored as `teams/manifests/{team}/{snapshot}.json`. Channel shards live under
 * `teams/shards/`, outside this prefix, so they never appear in an index listing.
 *
 * Reads that find damaged or newer-format content report it as a key rather than throwing, except
 * `find_by_snapshot`, which raises for the one snapshot the caller named.
 */
export interface TeamsIndexRepository {
  /** Persists a snapshot index. Written only after every shard it lists is in storage. */
  save(ctx: TenantContext, index: TeamsSnapshotIndex): Promise<void>;

  /** Returns the newest readable index of a team, reporting the unreadable and unsupported indexes it skipped. */
  find_latest_readable(ctx: TenantContext, team_id: string): Promise<TeamsLatestIndex>;

  /** Lists every readable index of a team, newest first, reporting the keys it skipped. */
  list_by_team(ctx: TenantContext, team_id: string): Promise<TeamsSnapshotListing>;

  /** Lists every team that has an index object, with that team's readable and skipped indexes. */
  list_teams(ctx: TenantContext): Promise<TeamsTeamListing[]>;

  /** Lists every readable index in the tenant. Skips unreadable and unsupported objects. */
  list_all(ctx: TenantContext): Promise<TeamsSnapshotIndex[]>;

  /**
   * Returns one index by snapshot ID, or undefined when it does not exist.
   *
   * @throws UnreadableContentError when the index is damaged.
   * @throws UnsupportedFormatVersionError when the index was written by a newer format version.
   */
  find_by_snapshot(
    ctx: TenantContext,
    team_id: string,
    snapshot_id: string,
  ): Promise<TeamsSnapshotIndex | undefined>;
}
