import { randomBytes } from 'node:crypto';
import type {
  FailedItemLedger,
  NoSnapshotReason,
  TeamsChannelEntry,
  TeamsDeltaCursorRepository,
  TeamsGraphResource,
  TeamsManifestRepository,
  TeamsSnapshotManifest,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  build_teams_cursor,
  build_teams_manifest,
} from '@/services/backup/backup-manifest-builder';

/** The content a snapshot records for a team. */
export interface SnapshotContent {
  readonly team: TeamsGraphResource;
  readonly members: TeamsGraphResource[];
  readonly channels: TeamsChannelEntry[];
}

/** Everything the persister writes: the snapshot, and the cursor that points past it. */
export interface SnapshotPersistInput extends SnapshotContent {
  readonly tenant_id: string;
  readonly team_id: string;
  readonly team_display_name: string | undefined;
  readonly backup_at: Date;
  /** The previous snapshot, if any, used to detect a run that changed nothing. */
  readonly previous: SnapshotContent | undefined;
  readonly links: Record<string, string>;
  readonly channel_ids: ReadonlySet<string>;
  readonly failed_roots: FailedItemLedger;
}

/** The ports the persister writes through. */
export interface SnapshotPorts {
  readonly manifests: TeamsManifestRepository;
  readonly cursors: TeamsDeltaCursorRepository;
}

/** The snapshot written by a run, or the reason none was written. */
export interface SnapshotPersistResult {
  readonly manifest: TeamsSnapshotManifest | undefined;
  readonly no_snapshot_reason: NoSnapshotReason | undefined;
}

/**
 * Returns why a completed run needs no new snapshot, or undefined when it does. A team with no
 * channels has nothing to capture. A run whose content matches the previous snapshot changed
 * nothing that a snapshot would record.
 */
export function snapshot_skip_reason(
  content: SnapshotContent,
  previous: SnapshotContent | undefined,
): NoSnapshotReason | undefined {
  if (content.channels.length === 0) {
    return 'no_content';
  }
  if (previous !== undefined && snapshot_fingerprint(content) === snapshot_fingerprint(previous)) {
    return 'no_changes';
  }
  return undefined;
}

/**
 * Saves the snapshot manifest when the run changed something, then always saves the cursor that
 * points past it (#339). A manifest save failure leaves the cursor where it was.
 */
export async function persist_team_snapshot(
  ctx: TenantContext,
  ports: SnapshotPorts,
  input: SnapshotPersistInput,
): Promise<SnapshotPersistResult> {
  const reason = snapshot_skip_reason(input, input.previous);
  let manifest: TeamsSnapshotManifest | undefined;
  if (reason === undefined) {
    manifest = build_teams_manifest({
      tenant_id: input.tenant_id,
      team_id: input.team_id,
      team_display_name: input.team_display_name,
      snapshot_id: `teams-snap-${input.backup_at.getTime()}-${randomBytes(3).toString('hex')}`,
      created_at: input.backup_at,
      team: input.team,
      members: input.members,
      channels: input.channels,
    });
    await ports.manifests.save(ctx, manifest);
  }
  const cursor = build_teams_cursor(
    input.team_id,
    input.links,
    input.channel_ids,
    input.backup_at.toISOString(),
    input.failed_roots,
  );
  await ports.cursors.save(ctx, cursor);
  return { manifest, no_snapshot_reason: reason };
}

/**
 * Serializes the content a snapshot records. Each channel's read mode is left out, because a
 * delta read and a full read of unchanged content produce the same snapshot. Member and tab lists
 * are sorted by id first: Graph returns them in no stable order, which would otherwise make every
 * unchanged run look changed.
 */
function snapshot_fingerprint(content: SnapshotContent): string {
  return JSON.stringify({
    team: content.team,
    members: sort_by_id(content.members),
    channels: content.channels.map((channel) => ({
      ...channel,
      read_mode: undefined,
      members: sort_by_id(channel.members),
      tabs: sort_by_id(channel.tabs),
    })),
  });
}

function sort_by_id(resources: readonly TeamsGraphResource[]): TeamsGraphResource[] {
  return [...resources].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}
