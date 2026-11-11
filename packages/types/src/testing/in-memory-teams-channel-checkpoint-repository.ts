import type { TeamsChannelCheckpointRepository } from '@/ports/teams/channel-checkpoint-repository.port';
import type {
  TeamsChannelCheckpointHead,
  TeamsChannelCheckpointHostedEntry,
  TeamsChannelCheckpointSegment,
} from '@/domain/teams/checkpoint';
import type { TenantContext } from '@/ports/tenant/context.port';

/** An in-memory checkpoint store keyed by team and channel, for tests that never touch S3. */
export class InMemoryTeamsChannelCheckpointRepository implements TeamsChannelCheckpointRepository {
  readonly heads = new Map<string, TeamsChannelCheckpointHead>();
  readonly segments = new Map<string, TeamsChannelCheckpointSegment>();
  readonly hosted_entries = new Map<string, TeamsChannelCheckpointHostedEntry>();

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
    const segment = this.segments.get(named_key(team_id, channel_id, name));
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
    this.segments.set(named_key(team_id, channel_id, name), segment);
  }

  async save_head(_ctx: TenantContext, head: TeamsChannelCheckpointHead): Promise<void> {
    this.heads.set(channel_key(head.team_id, head.channel_id), head);
  }

  async save_hosted_entry(
    _ctx: TenantContext,
    team_id: string,
    channel_id: string,
    name: string,
    entry: TeamsChannelCheckpointHostedEntry,
  ): Promise<void> {
    this.hosted_entries.set(named_key(team_id, channel_id, name), entry);
  }

  async load_hosted_entries(
    _ctx: TenantContext,
    team_id: string,
    channel_id: string,
  ): Promise<TeamsChannelCheckpointHostedEntry[]> {
    const prefix = `${channel_key(team_id, channel_id)}/`;
    return [...this.hosted_entries]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, entry]) => entry);
  }

  async delete_channel(_ctx: TenantContext, team_id: string, channel_id: string): Promise<void> {
    const prefix = `${channel_key(team_id, channel_id)}/`;
    this.heads.delete(channel_key(team_id, channel_id));
    for (const store of [this.segments, this.hosted_entries]) {
      for (const key of [...store.keys()]) {
        if (key.startsWith(prefix)) store.delete(key);
      }
    }
  }
}

function channel_key(team_id: string, channel_id: string): string {
  return `${team_id}/${channel_id}`;
}

function named_key(team_id: string, channel_id: string, name: string): string {
  return `${channel_key(team_id, channel_id)}/${name}`;
}
