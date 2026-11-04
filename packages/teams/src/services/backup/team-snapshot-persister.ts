import { randomBytes } from 'node:crypto';
import type {
  NoSnapshotReason,
  TeamsChannelCheckpointRepository,
  TeamsChannelCursorRepository,
  TeamsChannelIndexEntry,
  TeamsChannelShardRepository,
  TeamsGraphResource,
  TeamsIndexRepository,
  TeamsSnapshotIndex,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  build_channel_cursor,
  build_channel_index_entry,
  build_team_index,
} from '@/services/backup/backup-index-builder';
import type { ChannelBackupOutput } from '@/services/backup/channel-backup-processor';
import { canonical_json } from '@/services/shared/canonical-json';

/** One processed channel: its index entry and the backup output that produced it. */
export interface ChannelSave {
  readonly channel_id: string;
  readonly entry: TeamsChannelIndexEntry;
  readonly output: ChannelBackupOutput;
}

/** The ports the persister writes through. */
export interface SnapshotPorts {
  readonly indexes: TeamsIndexRepository;
  readonly cursors: TeamsChannelCursorRepository;
  readonly checkpoints: TeamsChannelCheckpointRepository;
  /** The context checkpoints are written through, without the run's Object Lock. Defaults to `ctx`. */
  readonly checkpoint_ctx?: TenantContext | undefined;
}

/** Everything the snapshot step writes: the team-level content and the processed channels. */
export interface SnapshotPersistInput {
  readonly tenant_id: string;
  readonly team_id: string;
  readonly team_display_name: string | undefined;
  readonly backup_at: Date;
  readonly team: TeamsGraphResource;
  readonly members: TeamsGraphResource[];
  /** The merged channel list the index would hold. */
  readonly channels: TeamsChannelIndexEntry[];
  /** The latest readable index, if any. Detects a run that changed nothing. */
  readonly previous: TeamsSnapshotIndex | undefined;
  readonly saves: readonly ChannelSave[];
}

/** The index written by a run, or the reason none was written. */
export interface SnapshotPersistResult {
  readonly index: TeamsSnapshotIndex | undefined;
  readonly no_snapshot_reason: NoSnapshotReason | undefined;
}

/**
 * Saves each processed channel's new shard and returns its index entry. A channel whose content is
 * unchanged keeps its previous entry and saves nothing. Runs before the index, so a failed run
 * leaves no index pointing at a missing shard.
 */
export async function save_channel_shards(
  ctx: TenantContext,
  shards: TeamsChannelShardRepository,
  results: ReadonlyMap<string, ChannelBackupOutput>,
): Promise<ChannelSave[]> {
  const saves: ChannelSave[] = [];
  for (const [channel_id, output] of results) {
    const entry =
      output.reused_entry ??
      build_channel_index_entry(output.shard, await shards.save(ctx, output.shard));
    saves.push({ channel_id, entry, output });
  }
  return saves;
}

/**
 * Saves the team index when the run changed something, then saves the cursor of every processed
 * channel. Each cursor is bound to its channel's merged shard key, so the next run trusts its delta
 * link only while that shard is the channel's latest. A failed index save leaves the cursors where
 * they were.
 */
export async function persist_team_snapshot(
  ctx: TenantContext,
  ports: SnapshotPorts,
  input: SnapshotPersistInput,
): Promise<SnapshotPersistResult> {
  const reason = snapshot_skip_reason(input);
  let index: TeamsSnapshotIndex | undefined;
  if (reason === undefined) {
    const created_at = new Date(
      Math.max(Date.now(), (input.previous?.created_at.getTime() ?? 0) + 1),
    );
    index = build_team_index({
      tenant_id: input.tenant_id,
      team_id: input.team_id,
      team_display_name: input.team_display_name,
      snapshot_id: `teams-snap-${created_at.getTime()}-${randomBytes(3).toString('hex')}`,
      created_at,
      team: input.team,
      members: input.members,
      channels: input.channels,
    });
    await ports.indexes.save(ctx, index);
  }
  const updated_at = input.backup_at.toISOString();
  for (const { channel_id, entry, output } of input.saves) {
    await ports.cursors.save(
      ctx,
      build_channel_cursor({
        team_id: input.team_id,
        channel_id,
        delta_link: output.next_link,
        baseline_shard_key: entry.shard_key,
        failed_roots: output.failed_roots,
        hosted_recheck: output.hosted_recheck,
        updated_at,
      }),
    );
    await settle_checkpoint(
      ports.checkpoint_ctx ?? ctx,
      ports.checkpoints,
      input.team_id,
      channel_id,
      entry,
      output,
    );
  }
  return { index, no_snapshot_reason: reason };
}

/**
 * Settles a channel's checkpoint once its cursor is saved. A finished read deletes its checkpoint.
 * An interrupted read rebinds its checkpoint to the shard just saved, so the next run can resume.
 */
async function settle_checkpoint(
  ctx: TenantContext,
  checkpoints: TeamsChannelCheckpointRepository,
  team_id: string,
  channel_id: string,
  entry: TeamsChannelIndexEntry,
  output: ChannelBackupOutput,
): Promise<void> {
  if (output.checkpoint === undefined) return;
  if (!output.interrupted) {
    await checkpoints.delete_channel(ctx, team_id, channel_id);
    return;
  }
  await checkpoints.save_head(ctx, { ...output.checkpoint, baseline_shard_key: entry.shard_key });
}

/**
 * Returns why a completed run needs no new index, or undefined when it does. A team with no
 * channels has nothing to capture. A run whose content matches the latest index changed nothing an
 * index would record.
 */
function snapshot_skip_reason(input: SnapshotPersistInput): NoSnapshotReason | undefined {
  if (input.channels.length === 0) {
    return 'no_content';
  }
  if (
    input.previous !== undefined &&
    snapshot_fingerprint(input.team, input.members, input.channels) ===
      snapshot_fingerprint(input.previous.team, input.previous.members, input.previous.channels)
  ) {
    return 'no_changes';
  }
  return undefined;
}

/**
 * Serializes the content an index records. Members are sorted by id and channels by channel id,
 * because Graph returns them in no stable order. Each channel is represented by its shard key, so
 * a channel whose shard content changed changes the fingerprint.
 */
function snapshot_fingerprint(
  team: TeamsGraphResource,
  members: TeamsGraphResource[],
  channels: TeamsChannelIndexEntry[],
): string {
  return canonical_json({
    team,
    members: [...members].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    channels: [...channels].sort((a, b) => a.channel_id.localeCompare(b.channel_id)),
  });
}
