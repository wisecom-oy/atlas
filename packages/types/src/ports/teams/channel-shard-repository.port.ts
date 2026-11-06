import type { TeamsChannelShard, TeamsStoredBlobRef } from '@/domain/teams/manifest';
import type { TenantContext } from '@/ports/tenant/context.port';

/**
 * Channel shards, stored under the HMAC of their canonical JSON so a channel that did not change
 * between snapshots is written once and referenced by every index that lists it.
 */
export interface TeamsChannelShardRepository {
  /**
   * Stores a shard under its content name. Writes nothing when an object with that name already
   * exists, since identical content has identical bytes.
   */
  save(ctx: TenantContext, shard: TeamsChannelShard): Promise<TeamsStoredBlobRef>;

  /**
   * Loads and verifies a shard: the bytes must match the checksum in the key's content name, and
   * the team and channel in the body must match the key.
   *
   * @throws UnreadableContentError when the shard is damaged or does not match its key.
   * @throws UnsupportedFormatVersionError when the shard was written by a newer format version.
   */
  load(ctx: TenantContext, storage_key: string): Promise<TeamsChannelShard>;
}
