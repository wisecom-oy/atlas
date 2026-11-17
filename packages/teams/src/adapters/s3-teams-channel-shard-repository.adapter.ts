import { injectable } from 'inversify';
import type {
  TeamsChannelShard,
  TeamsChannelShardRepository,
  TeamsStoredBlobRef,
  TenantContext,
} from '@wisecom/atlas-types';
import { UnreadableContentError, UnsupportedFormatVersionError } from '@wisecom/atlas-types';
import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
import { is_absent_object_error } from '@wisecom/atlas-core/services/shared/absent-object';
import { write_encrypted_json_text } from '@wisecom/atlas-core/services/shared/stored-json-writer';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { canonical_json } from '@/services/shared/canonical-json';
import { assert_shard_shape } from '@/services/shared/teams-object-shape';
import { teams_channel_shard_key } from '@/services/shared/storage-keys';

/**
 * Fetches and decrypts one shard. A missing object and a failed decryption are both damage; an
 * envelope a newer Atlas wrote is not, and keeps its own error.
 */
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
    if (err instanceof UnsupportedFormatVersionError) throw err;
    throw new UnreadableContentError(`The Teams channel shard at ${key} is corrupt or tampered`, {
      cause: err,
    });
  }
}

/** Parses a shard's plaintext as JSON; nothing in the body is trusted yet. */
function parse_shard_json(key: string, plaintext: Buffer): unknown {
  try {
    return JSON.parse(plaintext.toString('utf-8')) as unknown;
  } catch (err) {
    throw new UnreadableContentError(`The Teams channel shard at ${key} is not valid JSON`, {
      cause: err,
    });
  }
}

/**
 * The format version, shape and identity checks of a parsed shard body and the plaintext it was
 * parsed from, shared by reader and writer.
 */
function require_shard_under_key(
  ctx: TenantContext,
  key: string,
  body: unknown,
  plaintext: Buffer,
): TeamsChannelShard {
  assert_shard_shape(key, body);
  if (!names_key(ctx, body, plaintext, key)) {
    throw new UnreadableContentError(
      `The Teams channel shard at ${key} does not match its team, channel, or content name`,
    );
  }
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
   * Writes the shard unless a readable object with its content name already exists. An existing
   * object is loaded with the checks `load` applies before it is trusted, and a damaged one is
   * overwritten: skipping the write would leave the damage in place for every later run. One
   * written by a newer Atlas format raises `UnsupportedFormatVersionError` and is not overwritten.
   *
   * The write is refused when `load` would reject the shard. It is an overwrite because it may
   * replace a damaged object, and it is not read back: a run writes one shard per changed channel.
   */
  async save(ctx: TenantContext, shard: TeamsChannelShard): Promise<TeamsStoredBlobRef> {
    const json_text = canonical_json(shard);
    const plaintext = Buffer.from(json_text);
    const { checksum, content_name } = compute_content_digests(ctx, plaintext);
    const key = teams_channel_shard_key(shard.team_id, shard.channel_id, content_name);
    if (!(await this.holds_readable_shard(ctx, key))) {
      await write_encrypted_json_text(
        ctx,
        {
          key,
          label: 'Teams channel shard',
          reader_check: (parsed) => require_shard_under_key(ctx, key, parsed, plaintext),
          write: 'overwrite',
          confirm_read_back: false,
        },
        json_text,
      );
    }
    return { storage_key: key, checksum, size_bytes: plaintext.length };
  }

  /** Whether `key` exists and loads cleanly. Newer-format and storage errors propagate. */
  private async holds_readable_shard(ctx: TenantContext, key: string): Promise<boolean> {
    if (!(await ctx.storage.exists(key))) return false;
    try {
      await this.load(ctx, key);
      return true;
    } catch (err) {
      if (!(err instanceof UnreadableContentError)) throw err;
      logger.warn(`${err.message}; overwriting it with the shard this run built`);
      return false;
    }
  }

  /** Loads one shard, raising when it is missing, damaged, newer-format, or misnamed. */
  async load(ctx: TenantContext, storage_key: string): Promise<TeamsChannelShard> {
    const plaintext = await read_plaintext(ctx, storage_key);
    const body = parse_shard_json(storage_key, plaintext);
    return require_shard_under_key(ctx, storage_key, body, plaintext);
  }
}
