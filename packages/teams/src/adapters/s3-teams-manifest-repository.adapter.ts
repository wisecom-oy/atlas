import { injectable } from 'inversify';
import type {
  TeamsManifestRepository,
  TeamsSnapshotManifest,
  TenantContext,
} from '@wisecom/atlas-types';
import { StorageError } from '@wisecom/atlas-types';
import { is_absent_object_error } from '@wisecom/atlas-core/services/shared/absent-object';
import { TEAMS_KEYS } from '@/services/shared/storage-keys';

/** A manifest whose decrypted body does not describe the snapshot its key names. */
class InvalidTeamsManifestError extends Error {
  constructor(
    readonly storage_key: string,
    reason: string,
  ) {
    super(`The Teams manifest at ${storage_key} ${reason}`);
  }
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

  /** Returns the most recent manifest for a team. */
  async find_latest_by_team(
    ctx: TenantContext,
    team_id: string,
  ): Promise<TeamsSnapshotManifest | undefined> {
    return (await this.list_snapshots_by_team(ctx, team_id)).at(0);
  }

  /** Lists every manifest of a team, sorted newest first. */
  async list_snapshots_by_team(
    ctx: TenantContext,
    team_id: string,
  ): Promise<TeamsSnapshotManifest[]> {
    return this.download_under(ctx, TEAMS_KEYS.manifest_prefix_for(team_id));
  }

  /** Lists every manifest in the tenant, sorted newest first. */
  async list_all_manifests(ctx: TenantContext): Promise<TeamsSnapshotManifest[]> {
    return this.download_under(ctx, TEAMS_KEYS.manifest_root_prefix());
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
   * SharePoint uses, issue #340). Only absence returns undefined; anything else is damage.
   */
  private async download_manifest(
    ctx: TenantContext,
    key: string,
  ): Promise<TeamsSnapshotManifest | undefined> {
    let parsed: TeamsSnapshotManifest;
    try {
      const payload = await ctx.storage.get(key);
      parsed = JSON.parse(ctx.decrypt(payload, key).toString('utf-8')) as TeamsSnapshotManifest;
    } catch (err) {
      if (is_absent_object_error(err)) return undefined;
      throw new StorageError(`Could not read the Teams manifest at ${key}`, { cause: err });
    }
    if (TEAMS_KEYS.manifest_key(parsed.team_id, parsed.snapshot_id) !== key) {
      throw new InvalidTeamsManifestError(key, 'names a different team or snapshot than its key');
    }
    const created_at = new Date(parsed.created_at);
    if (Number.isNaN(created_at.getTime())) {
      throw new InvalidTeamsManifestError(key, 'has an unreadable created_at');
    }
    return { ...parsed, created_at };
  }
}
