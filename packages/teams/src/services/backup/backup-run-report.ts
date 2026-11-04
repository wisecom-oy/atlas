import type { TeamsChannelRunReport, TeamsGraphResource } from '@wisecom/atlas-types';
import type { ChannelRunState } from '@/services/backup/channel-run-loop';

/** One report row per selected channel, in listing order. Unstarted channels are `not_started`. */
export function build_channel_run_reports(
  channels: TeamsGraphResource[],
  state: ChannelRunState,
  roots_applied: ReadonlyMap<string, number>,
): TeamsChannelRunReport[] {
  return channels.map((channel) => {
    const record = state.records.get(channel.id);
    return {
      channel_id: channel.id,
      outcome: record?.outcome ?? 'not_started',
      read_mode: record?.read_mode,
      roots_applied: roots_applied.get(channel.id) ?? 0,
      resumed_from_checkpoint: record?.resumed_from_checkpoint ?? false,
      elapsed_ms: record?.elapsed_ms ?? 0,
    };
  });
}
