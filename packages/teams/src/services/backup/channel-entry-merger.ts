import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import type { TeamsChannelIndexEntry, TeamsGraphResource } from '@wisecom/atlas-types';

/** Inputs for building the channel list of one snapshot index. */
export interface ChannelMergeInput {
  /** Every channel Graph listed for the team this run. */
  readonly channels: TeamsGraphResource[];
  /** Entries this run produced for processed channels, keyed by channel id. */
  readonly processed: ReadonlyMap<string, TeamsChannelIndexEntry>;
  readonly previous: TeamsChannelIndexEntry[] | undefined;
  readonly backup_at: string;
}

/**
 * Builds the channel list for a snapshot index. A listed channel the run did not process keeps its
 * previous entry, and any listed channel is live again, so its `deleted_at` is cleared. A previous
 * channel Graph no longer lists is kept with `deleted_at` set.
 */
export function merge_channel_entries(input: ChannelMergeInput): TeamsChannelIndexEntry[] {
  const current = input.channels.flatMap((channel) => {
    const entry =
      input.processed.get(channel.id) ?? input.previous?.find((c) => c.channel_id === channel.id);
    return entry === undefined ? [] : [{ ...entry, deleted_at: undefined }];
  });
  const listed_ids = new Set(input.channels.map((channel) => channel.id));
  const removed = (input.previous ?? [])
    .filter((entry) => !listed_ids.has(entry.channel_id))
    .map((entry) => ({ ...entry, deleted_at: entry.deleted_at ?? input.backup_at }));
  return [...current, ...removed];
}

/**
 * Errors for a team whose listed channels were all owned by another tenant. Such a run backs up
 * nothing, so it must not report healthy. A team with no channels at all is not an error here.
 */
export function all_channels_foreign_errors(
  channels: TeamsGraphResource[],
  owned: TeamsGraphResource[],
  team_id: string,
): string[] {
  if (channels.length === 0 || owned.length > 0) return [];
  return [`Every channel of team ${team_id} is owned by another tenant; nothing was backed up`];
}

/**
 * Channels this tenant's token can read, plus a warning for each channel owned by another tenant.
 * `tenant_id` is the tenant GUID; both sides are lowercased before the comparison.
 */
export function split_owned_channels(
  channels: TeamsGraphResource[],
  tenant_id: string,
): { owned: TeamsGraphResource[]; warnings: string[] } {
  const tenant = normalize_owner_id(tenant_id);
  const owned: TeamsGraphResource[] = [];
  const warnings: string[] = [];
  for (const channel of channels) {
    const owner =
      typeof channel.tenantId === 'string' ? normalize_owner_id(channel.tenantId) : tenant;
    if (owner === tenant) {
      owned.push(channel);
    } else {
      warnings.push(`Channel ${channel.id} is owned by another tenant; skipped`);
    }
  }
  return { owned, warnings };
}
