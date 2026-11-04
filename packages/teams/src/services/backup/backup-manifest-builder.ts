import type {
  FailedItemLedger,
  TeamsChannelEntry,
  TeamsDeltaCursor,
  TeamsGraphResource,
  TeamsSnapshotManifest,
} from '@wisecom/atlas-types';

/** Inputs for the manifest a run writes. */
export interface ManifestInput {
  readonly tenant_id: string;
  readonly team_id: string;
  readonly team_display_name: string | undefined;
  readonly snapshot_id: string;
  readonly created_at: Date;
  readonly team: TeamsGraphResource;
  readonly members: TeamsGraphResource[];
  readonly channels: TeamsChannelEntry[];
}

/** Builds the snapshot manifest, with thread and byte totals taken from its channels. */
export function build_teams_manifest(input: ManifestInput): TeamsSnapshotManifest {
  const threads = input.channels.flatMap((channel) => Object.values(channel.threads));
  const total_size_bytes = threads.reduce(
    (sum, thread) =>
      sum +
      thread.size_bytes +
      Object.values(thread.hosted).reduce((hosted_sum, item) => hosted_sum + item.size_bytes, 0),
    0,
  );
  return {
    id: `${input.team_id}-${input.snapshot_id}`,
    tenant_id: input.tenant_id,
    team_id: input.team_id,
    team_display_name: input.team_display_name,
    snapshot_id: input.snapshot_id,
    created_at: input.created_at,
    team: input.team,
    members: input.members,
    channels: input.channels,
    total_threads: threads.length,
    total_size_bytes,
  };
}

/** Builds the delta cursor for a team, keeping links and failed roots only for channels the team still has. */
export function build_teams_cursor(
  team_id: string,
  links: Record<string, string>,
  channel_ids: ReadonlySet<string>,
  updated_at: string,
  failed_roots: FailedItemLedger,
): TeamsDeltaCursor {
  const kept = Object.entries(links).filter(([channel_id]) => channel_ids.has(channel_id));
  const kept_roots = Object.entries(failed_roots).filter(([, record]) =>
    channel_ids.has(record.drive_id),
  );
  return {
    team_id,
    delta_link_by_channel: Object.fromEntries(kept),
    failed_roots: Object.fromEntries(kept_roots),
    updated_at,
  };
}
