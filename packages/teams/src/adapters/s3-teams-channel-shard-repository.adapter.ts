import { injectable } from 'inversify';
import type {
  TeamsChannelShard,
  TeamsChannelShardRepository,
  TeamsShardSaveOptions,
  TeamsStoredBlobRef,
  TenantContext,
} from '@wisecom/atlas-types';
import { UnreadableContentError } from '@wisecom/atlas-types';
import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
import { is_absent_object_error } from '@wisecom/atlas-core/services/shared/absent-object';
import { canonical_json } from '@/services/shared/canonical-json';
import { assert_shard_shape } from '@/services/shared/teams-object-shape';
import { teams_channel_shard_key } from '@/services/shared/storage-keys';

/** Fetches and decrypts one shard. A missing object and a failed decryption are both damage. */
async function read_plaintext(ctx: TenantContext, key: string): Promise<Buffer> {
  let payload: Buffer;
  try {
    payload = await ctx.storage.get(key);
  } catch (err) {
    if (is_absent_object_error(err)) {
      throw new UnreadableContentError(`The Teams channel shard at ${key} is missing`, {
        cause: err,
      });
    }
    throw err;
  }
  try {
    return ctx.decrypt(payload, key);
  } catch (err) {
    throw new UnreadableContentError(`The Teams channel shard at ${key} is corrupt or tampered`, {
      cause: err,
    });
  }
}

/** Parses a shard body and checks its format version and shape before any field is trusted. */
function parse_shard(key: string, plaintext: Buffer): TeamsChannelShard {
  let body: unknown;
  try {
    body = JSON.parse(plaintext.toString('utf-8'));
  } catch (err) {
    throw new UnreadableContentError(`The Teams channel shard at ${key} is not valid JSON`, {
      cause: err,
    });
  }
  assert_shard_shape(key, body);
  return body;
}

/**
 * Whether a shard belongs under the key it was read from. Rebuilding the key from the body's team,
 * channel, and the HMAC of the plaintext must reproduce it, which checks the bytes against their
 * content name and the identity against the key in one comparison.
 */
function names_key(
  ctx: TenantContext,
  shard: TeamsChannelShard,
  plaintext: Buffer,
  key: string,
): boolean {
  try {
    const { content_name } = compute_content_digests(ctx, plaintext);
    return teams_channel_shard_key(shard.team_id, shard.channel_id, content_name) === key;
  } catch {
    return false;
  }
}

/** Stores shards under their content HMAC, so an unchanged channel is written once. */
@injectable()
export class S3TeamsChannelShardRepository implements TeamsChannelShardRepository {
  /**
   * Writes the shard unless an object with its content name already exists. An existing object at
   * `replace_unreadable_key` is written again, because its bytes are known to be damaged.
   */
  async save(
    ctx: TenantContext,
    shard: TeamsChannelShard,
    options: TeamsShardSaveOptions = {},
  ): Promise<TeamsStoredBlobRef> {
    const plaintext = Buffer.from(canonical_json(shard));
    const { checksum, content_name } = compute_content_digests(ctx, plaintext);
    const key = teams_channel_shard_key(shard.team_id, shard.channel_id, content_name);
    if (key === options.replace_unreadable_key || !(await ctx.storage.exists(key))) {
      await ctx.storage.put(key, ctx.encrypt(plaintext, key));
    }
    return { storage_key: key, checksum, size_bytes: plaintext.length };
  }

  /** Loads one shard, raising when it is missing, damaged, newer-format, or misnamed. */
  async load(ctx: TenantContext, storage_key: string): Promise<TeamsChannelShard> {
    const plaintext = await read_plaintext(ctx, storage_key);
    const shard = parse_shard(storage_key, plaintext);
    if (!names_key(ctx, shard, plaintext, storage_key)) {
      throw new UnreadableContentError(
        `The Teams channel shard at ${storage_key} does not match its team, channel, or content name`,
      );
    }
    return shard;
  }
}
