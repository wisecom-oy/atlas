import { injectable } from 'inversify';
import type {
  TeamsIndexRepository,
  TeamsLatestIndex,
  TeamsSnapshotIndex,
  TeamsSnapshotListing,
  TeamsTeamListing,
  TenantContext,
} from '@wisecom/atlas-types';
import { UnreadableContentError, UnsupportedFormatVersionError } from '@wisecom/atlas-types';
import { load_encrypted_json } from '@wisecom/atlas-core/services/shared/encrypted-state-reader';
import { write_encrypted_json } from '@wisecom/atlas-core/services/shared/stored-json-writer';
import { all_index_keys, team_index_keys, TEAMS_KEYS } from '@/services/shared/storage-keys';
import { assert_index_shape, type StoredTeamsIndex } from '@/services/shared/teams-object-shape';

/**
 * Whether an index body names the key it was read from. Every object is encrypted under the same
 * tenant key, so a body copied to another key still decrypts; rebuilding the key from the body is
 * what tells them apart.
 */
function names_key(index: StoredTeamsIndex, key: string): boolean {
  try {
    return TEAMS_KEYS.manifest_key(index.team_id, index.snapshot_id) === key;
  } catch {
    return false;
  }
}

/** Keys an index read skipped, by the reason it could not be used. */
type SkippedIndexKeys = { unreadable_keys: string[]; unsupported_keys: string[] };

/** Epoch milliseconds in a `teams-snap-{epoch}-{suffix}.json` key; keys without one sort oldest. */
function snapshot_epoch(key: string): number {
  const match = /teams-snap-(\d+)-[^/]*\.json$/.exec(key);
  return match ? Number(match[1]) : -1;
}

/** Persists Teams snapshot indexes as encrypted JSON, one object per snapshot. */
@injectable()
export class S3TeamsIndexRepository implements TeamsIndexRepository {
  /**
   * Stores an index under its team and snapshot key. The write is create-only, refused when the
   * reader's checks would reject the body, and read back once it lands.
   */
  async save(ctx: TenantContext, index: TeamsSnapshotIndex): Promise<void> {
    await write_encrypted_json(
      ctx,
      {
        key: TEAMS_KEYS.manifest_key(index.team_id, index.snapshot_id),
        label: 'Teams snapshot index',
        reader_check: require_teams_index,
        write: 'create_only',
        confirm_read_back: true,
      },
      index,
    );
  }

  /**
   * Returns the newest readable index of a team. Keys are decrypted newest first by the snapshot
   * epoch in their name, and the first readable one ends the read. Damaged or newer-format indexes
   * are reported only when they are newer than the one returned, so older ones are never downloaded.
   */
  async find_latest_readable(ctx: TenantContext, team_id: string): Promise<TeamsLatestIndex> {
    const keys = await this.list_index_keys(ctx, team_id);
    keys.sort((a, b) => snapshot_epoch(b) - snapshot_epoch(a));
    const skipped: SkippedIndexKeys = { unreadable_keys: [], unsupported_keys: [] };
    for (const key of keys) {
      const index = await this.download_or_skip(ctx, key, skipped);
      if (index) return { index, ...skipped };
    }
    return { index: undefined, ...skipped };
  }

  /** Lists every readable index of a team, newest first, reporting the keys it skipped. */
  async list_by_team(ctx: TenantContext, team_id: string): Promise<TeamsSnapshotListing> {
    return this.read_listing(ctx, await this.list_index_keys(ctx, team_id));
  }

  /** Index keys of one team; only `{snapshot}.json` objects under its manifest prefix count. */
  private async list_index_keys(ctx: TenantContext, team_id: string): Promise<string[]> {
    const keys = await ctx.storage.list(TEAMS_KEYS.manifest_prefix_for(team_id));
    return team_index_keys(keys, team_id);
  }

  /** Lists every team that has an index object, grouping the tenant's index keys by team segment. */
  async list_teams(ctx: TenantContext): Promise<TeamsTeamListing[]> {
    const root = TEAMS_KEYS.manifest_root_prefix();
    const keys_by_team = new Map<string, string[]>();
    for (const key of all_index_keys(await ctx.storage.list(root))) {
      const team_id = key.slice(root.length).split('/')[0] ?? '';
      keys_by_team.set(team_id, [...(keys_by_team.get(team_id) ?? []), key]);
    }
    const teams: TeamsTeamListing[] = [];
    for (const [team_id, keys] of keys_by_team) {
      teams.push({ team_id, listing: await this.read_listing(ctx, keys) });
    }
    return teams;
  }

  /** Lists every readable index in the tenant. Skips unreadable and unsupported objects. */
  async list_all(ctx: TenantContext): Promise<TeamsSnapshotIndex[]> {
    const keys = await ctx.storage.list(TEAMS_KEYS.manifest_root_prefix());
    const { indexes } = await this.read_listing(ctx, all_index_keys(keys));
    return indexes;
  }

  /** Loads one index by snapshot id, raising when the object is damaged or newer-format. */
  async find_by_snapshot(
    ctx: TenantContext,
    team_id: string,
    snapshot_id: string,
  ): Promise<TeamsSnapshotIndex | undefined> {
    const key = TEAMS_KEYS.manifest_key(team_id, snapshot_id);
    const keys = await ctx.storage.list(TEAMS_KEYS.manifest_prefix_for(team_id));
    if (!keys.includes(key)) return undefined;
    return this.download_index(ctx, key);
  }

  /** Reads the index at exactly this key with the checks every listing applies. */
  async read_index_at(
    ctx: TenantContext,
    storage_key: string,
  ): Promise<TeamsSnapshotIndex | undefined> {
    return this.download_index(ctx, storage_key);
  }

  /** Reads each index key, sorting readable ones newest first and recording the rest by reason. */
  private async read_listing(ctx: TenantContext, keys: string[]): Promise<TeamsSnapshotListing> {
    const indexes: TeamsSnapshotIndex[] = [];
    const skipped: SkippedIndexKeys = { unreadable_keys: [], unsupported_keys: [] };
    for (const key of keys) {
      const index = await this.download_or_skip(ctx, key, skipped);
      if (index) indexes.push(index);
    }
    indexes.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    return { indexes, ...skipped };
  }

  /** Downloads one index; a damaged or newer-format index is recorded in `skipped` and yields undefined. */
  private async download_or_skip(
    ctx: TenantContext,
    key: string,
    skipped: SkippedIndexKeys,
  ): Promise<TeamsSnapshotIndex | undefined> {
    try {
      return await this.download_index(ctx, key);
    } catch (err) {
      if (err instanceof UnsupportedFormatVersionError) skipped.unsupported_keys.push(key);
      else if (err instanceof UnreadableContentError) skipped.unreadable_keys.push(key);
      else throw err;
      return undefined;
    }
  }

  /**
   * Downloads one index. Absence returns undefined. A body that fails to decrypt or parse, names
   * another key, or has an unreadable `created_at` raises `UnreadableContentError`; a newer
   * format version raises `UnsupportedFormatVersionError`.
   */
  private async download_index(
    ctx: TenantContext,
    key: string,
  ): Promise<TeamsSnapshotIndex | undefined> {
    const stored = await load_encrypted_json<unknown>(ctx, key);
    if (stored === undefined) return undefined;
    return require_teams_index(stored, key);
  }
}

/**
 * The shape, identity and date checks of a parsed index body, shared by reader and writer. Returns
 * the index with `created_at` revived as a Date.
 */
function require_teams_index(stored: unknown, key: string): TeamsSnapshotIndex {
  assert_index_shape(key, stored);
  if (!names_key(stored, key)) {
    throw new UnreadableContentError(
      `The Teams snapshot index at ${key} names a different team or snapshot than its key`,
    );
  }
  const created_at = new Date(stored.created_at);
  if (Number.isNaN(created_at.getTime())) {
    throw new UnreadableContentError(
      `The Teams snapshot index at ${key} has an unreadable created_at`,
    );
  }
  return { ...stored, created_at };
}
