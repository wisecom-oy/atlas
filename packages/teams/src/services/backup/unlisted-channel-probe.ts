import type {
  TeamsChannelIndexEntry,
  TeamsConnector,
  TeamsGraphResource,
} from '@wisecom/atlas-types';

/** Where the probe reads channels from. */
export interface UnlistedChannelSource {
  readonly connector: TeamsConnector;
  readonly tenant_id: string;
  readonly team_id: string;
}

/** What the run learned about backed-up channels this run's listing did not return. */
export interface UnlistedChannelProbe {
  /** Channels Graph still has. Their entries are kept as they were, never marked deleted. */
  readonly present_ids: ReadonlySet<string>;
  /** One error per channel in `present_ids`, so the run reports itself incomplete. */
  readonly errors: string[];
}

/**
 * Reads by id every channel the previous snapshot holds as live that this run's listing left out.
 * Graph cannot count a team's channels, so a short listing looks complete; only a 404 shows the
 * channel is gone (issue #853). Channels are read one at a time, so a large gap stays within the
 * team's request budget. Costs one request per vanished channel, once: a tombstoned channel is
 * not read again.
 */
export async function probe_unlisted_channels(
  source: UnlistedChannelSource,
  previous: readonly TeamsChannelIndexEntry[] | undefined,
  listed: readonly TeamsGraphResource[],
): Promise<UnlistedChannelProbe> {
  const listed_ids = new Set(listed.map((channel) => channel.id));
  const present_ids = new Set<string>();
  const errors: string[] = [];
  for (const entry of previous ?? []) {
    if (entry.deleted_at !== undefined || listed_ids.has(entry.channel_id)) continue;
    const exists = await source.connector.channel_exists(
      source.tenant_id,
      source.team_id,
      entry.channel_id,
    );
    if (!exists) continue;
    present_ids.add(entry.channel_id);
    errors.push(describe_unlisted_channel(entry, source.team_id));
  }
  return { present_ids, errors };
}

/** The run error for a channel Graph has but did not list. */
function describe_unlisted_channel(entry: TeamsChannelIndexEntry, team_id: string): string {
  const name = entry.display_name ?? entry.channel_id;
  return (
    `Channel ${name} is missing from the channel listing of team ${team_id} but still exists; ` +
    'its previous backup is kept unchanged'
  );
}
