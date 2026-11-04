import { injectable } from 'inversify';
import type {
  TeamsChannelCheckpointHead,
  TeamsChannelCheckpointRepository,
  TeamsChannelCheckpointSegment,
  TenantContext,
} from '@wisecom/atlas-types';
import { UnreadableContentError } from '@wisecom/atlas-types';
import { load_encrypted_json } from '@wisecom/atlas-core/services/shared/encrypted-state-reader';
import {
  assert_checkpoint_head_shape,
  assert_checkpoint_segment_shape,
} from '@/services/shared/teams-checkpoint-shape';
import {
  teams_checkpoint_head_key,
  teams_checkpoint_prefix,
  teams_checkpoint_segment_key,
} from '@/services/shared/storage-keys';

/** Persists one channel's read checkpoint as encrypted JSON: a head plus append-only segments. */
@injectable()
export class S3TeamsChannelCheckpointRepository implements TeamsChannelCheckpointRepository {
  /** Loads one channel's checkpoint head, or undefined when none was saved. */
  async load_head(
    ctx: TenantContext,
    team_id: string,
    channel_id: string,
  ): Promise<TeamsChannelCheckpointHead | undefined> {
    const key = teams_checkpoint_head_key(team_id, channel_id);
    const head = await load_encrypted_json<unknown>(ctx, key);
    if (head === undefined) return undefined;
    assert_checkpoint_head_shape(key, head);
    if (!names_head(head, key)) {
      throw new UnreadableContentError(
        `The Teams channel checkpoint at ${key} names a different team or channel than its key`,
      );
    }
    return head;
  }

  /** Loads one segment a head names. A missing segment is damage, so it throws. */
  async load_segment(
    ctx: TenantContext,
    team_id: string,
    channel_id: string,
    name: string,
  ): Promise<TeamsChannelCheckpointSegment> {
    const key = teams_checkpoint_segment_key(team_id, channel_id, name);
    const segment = await load_encrypted_json<unknown>(ctx, key);
    if (segment === undefined) {
      throw new UnreadableContentError(`The Teams channel checkpoint segment at ${key} is missing`);
    }
    assert_checkpoint_segment_shape(key, segment);
    return segment;
  }

  /** Encrypts and saves one segment under its channel's checkpoint prefix. */
  async save_segment(
    ctx: TenantContext,
    team_id: string,
    channel_id: string,
    name: string,
    segment: TeamsChannelCheckpointSegment,
  ): Promise<void> {
    const key = teams_checkpoint_segment_key(team_id, channel_id, name);
    await ctx.storage.put(key, ctx.encrypt(Buffer.from(JSON.stringify(segment)), key));
  }

  /** Encrypts and saves one channel's head under its team and channel key. */
  async save_head(ctx: TenantContext, head: TeamsChannelCheckpointHead): Promise<void> {
    const key = teams_checkpoint_head_key(head.team_id, head.channel_id);
    await ctx.storage.put(key, ctx.encrypt(Buffer.from(JSON.stringify(head)), key));
  }

  /** Deletes every object of one channel's checkpoint: its head and all of its segments. */
  async delete_channel(ctx: TenantContext, team_id: string, channel_id: string): Promise<void> {
    for (const key of await ctx.storage.list(teams_checkpoint_prefix(team_id, channel_id))) {
      await ctx.storage.delete(key);
    }
  }
}

/** Whether a head body names the key it was read from. */
function names_head(head: TeamsChannelCheckpointHead, key: string): boolean {
  try {
    return teams_checkpoint_head_key(head.team_id, head.channel_id) === key;
  } catch {
    return false;
  }
}
