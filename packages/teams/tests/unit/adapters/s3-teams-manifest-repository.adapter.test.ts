import { describe, expect, it, vi, type Mock } from 'vitest';
import type { TeamsSnapshotManifest, TenantContext } from '@wisecom/atlas-types';
import { S3TeamsManifestRepository } from '@/adapters/s3-teams-manifest-repository.adapter';
import { TEAMS_KEYS } from '@/services/shared/storage-keys';

const TEAM = 'team-1';
const OLD_SNAPSHOT = 'teams-snap-1000-aaaaaa';
const NEW_SNAPSHOT = 'teams-snap-2000-bbbbbb';

function manifest_json(team_id: string, snapshot_id: string): Buffer {
  const manifest = {
    team_id,
    snapshot_id,
    created_at: '2025-01-01T00:00:00.000Z',
  } as unknown as TeamsSnapshotManifest;
  return Buffer.from(JSON.stringify(manifest), 'utf-8');
}

/** A context whose storage holds one encrypted manifest per key, as the real adapter writes them. */
function make_ctx(bodies: Record<string, Buffer>): {
  ctx: TenantContext;
  get: Mock;
} {
  const get = vi.fn(async (key: string) => bodies[key]);
  const ctx = {
    storage: {
      list: vi.fn(async (prefix: string) =>
        Object.keys(bodies).filter((key) => key.startsWith(prefix)),
      ),
      get,
    },
    decrypt: (payload: Buffer) => payload,
  } as unknown as TenantContext;
  return { ctx, get };
}

describe('S3TeamsManifestRepository.find_latest_by_team', () => {
  it('decrypts only the newest snapshot even when an older one is listed first', async () => {
    const old_key = TEAMS_KEYS.manifest_key(TEAM, OLD_SNAPSHOT);
    const new_key = TEAMS_KEYS.manifest_key(TEAM, NEW_SNAPSHOT);
    const { ctx, get } = make_ctx({
      [old_key]: manifest_json(TEAM, OLD_SNAPSHOT),
      [new_key]: manifest_json(TEAM, NEW_SNAPSHOT),
    });

    const latest = await new S3TeamsManifestRepository().find_latest_by_team(ctx, TEAM);

    expect(latest?.snapshot_id).toBe(NEW_SNAPSHOT);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(new_key);
  });

  it('returns undefined for a team with no manifests', async () => {
    const { ctx, get } = make_ctx({});

    const latest = await new S3TeamsManifestRepository().find_latest_by_team(ctx, TEAM);

    expect(latest).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects a manifest body that names a different snapshot than its key', async () => {
    const key = TEAMS_KEYS.manifest_key(TEAM, NEW_SNAPSHOT);
    const { ctx } = make_ctx({ [key]: manifest_json(TEAM, OLD_SNAPSHOT) });

    await expect(new S3TeamsManifestRepository().find_latest_by_team(ctx, TEAM)).rejects.toThrow(
      'names a different team or snapshot than its key',
    );
  });
});
