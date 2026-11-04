import { injectable } from 'inversify';
import type {
  TeamsLatestManifest,
  TeamsManifestRepository,
  TeamsSnapshotListing,
  TeamsSnapshotManifest,
  TenantContext,
} from '@wisecom/atlas-types';
import { UnreadableContentError } from '@wisecom/atlas-types';
import { load_encrypted_json } from '@wisecom/atlas-core/services/shared/encrypted-state-reader';
import { TEAMS_KEYS } from '@/services/shared/storage-keys';
import { assert_readable_format_version } from '@/services/shared/format-version';

/** Epoch from a manifest key's `teams-snap-{epoch}-` snapshot id; -1 when the key has none. */
function snapshot_epoch(key: string): number {
  const match = /teams-snap-(\d+)-/.exec(key);
  return match ? Number(match[1]) : -1;
}

/** Persists Teams snapshot manifests as encrypted JSON in object storage. */
@injectable()
export class S3TeamsManifestRepository implements TeamsManifestRepository {
  /** Encrypts and uploads a manifest under its team and snapshot key. */
  async save(ctx: TenantContext, manifest: TeamsSnapshotManifest): Promise<void> {
    const key = TEAMS_KEYS.manifest_key(manifest.team_id, manifest.snapshot_id);
    await ctx.storage.put(key, ctx.encrypt(Buffer.from(JSON.stringify(manifest)), key));
  }

  /** Loads one manifest by listing only that team's manifest prefix. */
  async find_by_snapshot(
    ctx: TenantContext,
    team_id: string,
    snapshot_id: string,
  ): Promise<TeamsSnapshotManifest | undefined> {
    const expected_key = TEAMS_KEYS.manifest_key(team_id, snapshot_id);
    const keys = await ctx.storage.list(TEAMS_KEYS.manifest_prefix_for(team_id));
    if (!keys.includes(expected_key)) return undefined;
    return this.download_manifest(ctx, expected_key);
  }

  /**
   * Returns the newest readable manifest of a team. Newer manifests that cannot be read are
   * listed in `unreadable_keys` instead of failing the lookup, so one damaged snapshot does not
   * block every later run.
   */
  async find_latest_by_team(ctx: TenantContext, team_id: string): Promise<TeamsLatestManifest> {
    const keys = await ctx.storage.list(TEAMS_KEYS.manifest_prefix_for(team_id));
    return this.first_readable(ctx, keys);
  }

  /**
   * Returns the newest readable manifest of every team, keyed by team id. A team whose manifests
   * are all unreadable is still listed, with `manifest` undefined.
   */
  async list_latest_per_team(
    ctx: TenantContext,
  ): Promise<Array<{ team_id: string; manifest: TeamsSnapshotManifest | undefined }>> {
    const root = TEAMS_KEYS.manifest_root_prefix();
    const keys_by_team = new Map<string, string[]>();
    for (const key of await ctx.storage.list(root)) {
      const team_id = key.slice(root.length).split('/')[0] ?? '';
      keys_by_team.set(team_id, [...(keys_by_team.get(team_id) ?? []), key]);
    }
    const latest: Array<{ team_id: string; manifest: TeamsSnapshotManifest | undefined }> = [];
    for (const [team_id, keys] of keys_by_team) {
      const { manifest } = await this.first_readable(ctx, keys);
      latest.push({ team_id, manifest });
    }
    return latest;
  }

  /**
   * Lists every manifest of a team, newest first. A manifest that cannot be read is listed in
   * `unreadable_keys` rather than failing the listing, so one damaged snapshot does not hide the rest.
   */
  async list_snapshots_by_team(ctx: TenantContext, team_id: string): Promise<TeamsSnapshotListing> {
    const manifests: TeamsSnapshotManifest[] = [];
    const unreadable_keys: string[] = [];
    for (const key of await ctx.storage.list(TEAMS_KEYS.manifest_prefix_for(team_id))) {
      try {
        const manifest = await this.download_manifest(ctx, key);
        if (manifest) manifests.push(manifest);
      } catch (err) {
        if (!(err instanceof UnreadableContentError)) throw err;
        unreadable_keys.push(key);
      }
    }
    manifests.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    return { manifests, unreadable_keys };
  }

  /** Lists every manifest in the tenant, sorted newest first. */
  async list_all_manifests(ctx: TenantContext): Promise<TeamsSnapshotManifest[]> {
    return this.download_under(ctx, TEAMS_KEYS.manifest_root_prefix());
  }

  /**
   * Returns the first manifest in `keys` that reads back, trying the newest epoch first. Unreadable
   * keys are recorded before it; absent keys are skipped silently.
   */
  private async first_readable(ctx: TenantContext, keys: string[]): Promise<TeamsLatestManifest> {
    const unreadable_keys: string[] = [];
    for (const key of [...keys].sort((a, b) => snapshot_epoch(b) - snapshot_epoch(a))) {
      try {
        const manifest = await this.download_manifest(ctx, key);
        if (manifest) return { manifest, unreadable_keys };
      } catch (err) {
        if (!(err instanceof UnreadableContentError)) throw err;
        unreadable_keys.push(key);
      }
    }
    return { manifest: undefined, unreadable_keys };
  }

  private async download_under(
    ctx: TenantContext,
    prefix: string,
  ): Promise<TeamsSnapshotManifest[]> {
    const manifests: TeamsSnapshotManifest[] = [];
    for (const key of await ctx.storage.list(prefix)) {
      const parsed = await this.download_manifest(ctx, key);
      if (parsed) manifests.push(parsed);
    }
    return manifests.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  }

  /**
   * Downloads one manifest and rejects a body whose identity is not the key it was read from.
   *
   * Every manifest is encrypted under the same tenant key, so one manifest decrypts at any other
   * manifest's key. Rebuilding the key from the body is what tells them apart (the same guard
   * SharePoint uses, issue #340). Absence returns undefined. A body that fails to decrypt, parse,
   * or match its key raises `UnreadableContentError`, the same class the cursor raises.
   */
  private async download_manifest(
    ctx: TenantContext,
    key: string,
  ): Promise<TeamsSnapshotManifest | undefined> {
    const parsed = await load_encrypted_json<TeamsSnapshotManifest>(ctx, key);
    if (parsed === undefined) return undefined;
    assert_readable_format_version(key, parsed.format_version);
    if (TEAMS_KEYS.manifest_key(parsed.team_id, parsed.snapshot_id) !== key) {
      throw new UnreadableContentError(
        `The Teams manifest at ${key} names a different team or snapshot than its key`,
      );
    }
    const created_at = new Date(parsed.created_at);
    if (Number.isNaN(created_at.getTime())) {
      throw new UnreadableContentError(`The Teams manifest at ${key} has an unreadable created_at`);
    }
    return { ...parsed, created_at };
  }
}
