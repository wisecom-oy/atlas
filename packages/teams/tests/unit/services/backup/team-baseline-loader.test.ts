import { describe, expect, it, vi } from 'vitest';
import {
  UnreadableContentError,
  type TeamsDeltaCursor,
  type TeamsDeltaCursorRepository,
  type TeamsManifestRepository,
  type TeamsSnapshotManifest,
  type TenantContext,
} from '@wisecom/atlas-types';
import { load_team_baseline } from '@/services/backup/team-baseline-loader';

const TEAM = '00000000-0000-0000-0000-000000000001';
const OLD = 'teams-snap-1000-aaaaaa';
const NEW = 'teams-snap-2000-bbbbbb';
const CTX = {} as TenantContext;

function manifest(snapshot_id: string): TeamsSnapshotManifest {
  return { snapshot_id } as TeamsSnapshotManifest;
}

function cursor(snapshot_id: string | undefined): TeamsDeltaCursor {
  return {
    team_id: TEAM,
    snapshot_id,
    delta_link_by_channel: { 'channel-1': 'link' },
    updated_at: '2025-01-01T00:00:00.000Z',
  } as TeamsDeltaCursor;
}

function setup(options: {
  latest?: { manifest?: TeamsSnapshotManifest; unreadable_keys?: string[] };
  stored?: TeamsDeltaCursor | Error;
}) {
  const find_latest_by_team = vi.fn(async () => ({
    manifest: options.latest?.manifest,
    unreadable_keys: options.latest?.unreadable_keys ?? [],
  }));
  const load = vi.fn(async () => {
    if (options.stored instanceof Error) throw options.stored;
    return options.stored;
  });
  return {
    find_latest_by_team,
    load,
    ports: {
      manifests: { find_latest_by_team } as unknown as TeamsManifestRepository,
      cursors: { load } as unknown as TeamsDeltaCursorRepository,
    },
  };
}

describe('load_team_baseline', () => {
  it('returns the cursor when it names the latest snapshot (A4)', async () => {
    const stored = cursor(NEW);
    const { ports } = setup({ latest: { manifest: manifest(NEW) }, stored });

    const baseline = await load_team_baseline(CTX, ports, TEAM);

    expect(baseline.cursor).toBe(stored);
    expect(baseline.previous?.snapshot_id).toBe(NEW);
    expect(baseline.warnings).toEqual([]);
    expect(baseline.errors).toEqual([]);
  });

  it('drops a cursor saved against a different snapshot and reads in full (A4)', async () => {
    const { ports } = setup({ latest: { manifest: manifest(NEW) }, stored: cursor(OLD) });

    const baseline = await load_team_baseline(CTX, ports, TEAM);

    expect(baseline.cursor).toBeUndefined();
    expect(baseline.previous?.snapshot_id).toBe(NEW);
    expect(baseline.warnings).toEqual([
      `The delta cursor for team ${TEAM} does not match the latest snapshot; reading every channel in full`,
    ]);
  });

  it('never trusts a legacy cursor without snapshot_id (A4)', async () => {
    const { ports } = setup({ latest: { manifest: manifest(NEW) }, stored: cursor(undefined) });

    const baseline = await load_team_baseline(CTX, ports, TEAM);

    expect(baseline.cursor).toBeUndefined();
    expect(baseline.warnings).toHaveLength(1);
  });

  it('does not trust a legacy cursor when no snapshot exists either (A4)', async () => {
    const { ports } = setup({ latest: {}, stored: cursor(undefined) });

    const baseline = await load_team_baseline(CTX, ports, TEAM);

    expect(baseline.cursor).toBeUndefined();
    expect(baseline.previous).toBeUndefined();
  });

  it('reads in full with a warning when the cursor is unreadable (A4)', async () => {
    const { ports } = setup({
      latest: { manifest: manifest(NEW) },
      stored: new UnreadableContentError('bad cursor'),
    });

    const baseline = await load_team_baseline(CTX, ports, TEAM);

    expect(baseline.cursor).toBeUndefined();
    expect(baseline.previous?.snapshot_id).toBe(NEW);
    expect(baseline.warnings).toEqual([
      `The delta cursor for team ${TEAM} is unreadable; reading every channel in full`,
    ]);
    expect(baseline.errors).toEqual([]);
  });

  it('propagates cursor errors that are not unreadable content', async () => {
    const { ports } = setup({ stored: new Error('network down') });

    await expect(load_team_baseline(CTX, ports, TEAM)).rejects.toThrow('network down');
  });

  it('falls back to the older snapshot and reports the unreadable newer one (A4)', async () => {
    const newer_key = `teams/${TEAM}/${NEW}.json`;
    const { ports } = setup({
      latest: { manifest: manifest(OLD), unreadable_keys: [newer_key] },
      stored: cursor(NEW),
    });

    const baseline = await load_team_baseline(CTX, ports, TEAM);

    expect(baseline.previous?.snapshot_id).toBe(OLD);
    expect(baseline.errors).toEqual([
      `Snapshot ${newer_key} could not be read; its channels were not compared`,
    ]);
    expect(baseline.warnings).toEqual([
      'The baseline is an older snapshot because a newer one could not be read',
      `The delta cursor for team ${TEAM} does not match the latest snapshot; reading every channel in full`,
    ]);
    expect(baseline.cursor).toBeUndefined();
  });
});
