import type {
  FailedItemLedger,
  TeamsChannelEntry,
  TeamsDeltaCursor,
  TeamsGraphResource,
  TeamsSnapshotManifest,
} from '@wisecom/atlas-types';
import { thread_stored_blobs } from '@/services/shared/thread-blobs';

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
      sum + thread_stored_blobs(thread).reduce((blob_sum, blob) => blob_sum + blob.size_bytes, 0),
    0,
  );
  return {
    id: `${input.team_id}-${input.snapshot_id}`,
    format_version: 1,
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

/**
 * Keeps only the failed-root records whose channel the team still has. A record for a removed
 * channel can never be retried, so it must not keep the run unhealthy.
 */
export function keep_ledger_for_channels(
  ledger: FailedItemLedger,
  channel_ids: ReadonlySet<string>,
): FailedItemLedger {
  return Object.fromEntries(
    Object.entries(ledger).filter(([, record]) => channel_ids.has(record.drive_id)),
  );
}

/**
 * Builds the delta cursor for a team, keeping links and failed roots only for channels the team
 * still has.
 */
export function build_teams_cursor(
  team_id: string,
  links: Record<string, string>,
  channel_ids: ReadonlySet<string>,
  updated_at: string,
  failed_roots: FailedItemLedger,
): TeamsDeltaCursor {
  const kept = Object.entries(links).filter(([channel_id]) => channel_ids.has(channel_id));
  return {
    team_id,
    format_version: 1,
    delta_link_by_channel: Object.fromEntries(kept),
    failed_roots: keep_ledger_for_channels(failed_roots, channel_ids),
    updated_at,
  };
}
