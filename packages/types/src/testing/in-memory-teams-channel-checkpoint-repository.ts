import type { TeamsChannelCheckpointRepository } from '@/ports/teams/channel-checkpoint-repository.port';
import type {
  TeamsChannelCheckpointHead,
  TeamsChannelCheckpointSegment,
} from '@/domain/teams-checkpoint';
import type { TenantContext } from '@/ports/tenant/context.port';

/** An in-memory checkpoint store keyed by team and channel, for tests that never touch S3. */
export class InMemoryTeamsChannelCheckpointRepository implements TeamsChannelCheckpointRepository {
  readonly heads = new Map<string, TeamsChannelCheckpointHead>();
  readonly segments = new Map<string, TeamsChannelCheckpointSegment>();

  async load_head(
    _ctx: TenantContext,
    team_id: string,
    channel_id: string,
  ): Promise<TeamsChannelCheckpointHead | undefined> {
    return this.heads.get(channel_key(team_id, channel_id));
  }

  async load_segment(
    _ctx: TenantContext,
    team_id: string,
    channel_id: string,
    name: string,
  ): Promise<TeamsChannelCheckpointSegment> {
    const segment = this.segments.get(segment_key(team_id, channel_id, name));
    if (segment === undefined) throw new Error(`missing checkpoint segment ${name}`);
    return segment;
  }

  async save_segment(
    _ctx: TenantContext,
    team_id: string,
    channel_id: string,
    name: string,
    segment: TeamsChannelCheckpointSegment,
  ): Promise<void> {
    this.segments.set(segment_key(team_id, channel_id, name), segment);
  }

  async save_head(_ctx: TenantContext, head: TeamsChannelCheckpointHead): Promise<void> {
    this.heads.set(channel_key(head.team_id, head.channel_id), head);
  }

  async delete_channel(_ctx: TenantContext, team_id: string, channel_id: string): Promise<void> {
    const prefix = `${channel_key(team_id, channel_id)}/`;
    this.heads.delete(channel_key(team_id, channel_id));
    for (const key of [...this.segments.keys()]) {
      if (key.startsWith(prefix)) this.segments.delete(key);
    }
  }
}

function channel_key(team_id: string, channel_id: string): string {
  return `${team_id}/${channel_id}`;
}

function segment_key(team_id: string, channel_id: string, name: string): string {
  return `${channel_key(team_id, channel_id)}/${name}`;
}
