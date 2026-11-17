import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
import { is_absent_object_error } from '@wisecom/atlas-core/services/shared/absent-object';
import { emit_operation_progress } from '@wisecom/atlas-core/services/shared/operation-progress';
import { UnreadableContentError, UnsupportedFormatVersionError } from '@wisecom/atlas-types';
import type {
  TeamsChannelShard,
  TeamsChannelShardRepository,
  TeamsStoredBlobRef,
  TenantContext,
  VerificationOptions,
} from '@wisecom/atlas-types';

/** What a check found at one storage key. */
export type StorageKeyStatus = 'intact' | 'missing' | 'failed' | 'unsupported';

/** Counts checked keys and collects the ones that were missing or failed. */
export class IntegrityTally {
  checked = 0;
  readonly missing_storage_keys: string[] = [];
  readonly failed_storage_keys: string[] = [];
  readonly unsupported_storage_keys: string[] = [];

  /** Records one checked key under its status. */
  record(storage_key: string, status: StorageKeyStatus): void {
    this.checked++;
    if (status === 'missing') this.missing_storage_keys.push(storage_key);
    if (status === 'failed') this.failed_storage_keys.push(storage_key);
    if (status === 'unsupported') this.unsupported_storage_keys.push(storage_key);
  }
}

/**
 * Status of one blob. `fast` checks only existence. Otherwise the object is downloaded, decrypted,
 * and hashed against its recorded size and SHA-256 checksum. Other storage errors propagate.
 */
export async function blob_status(
  ctx: TenantContext,
  ref: TeamsStoredBlobRef,
  fast: boolean,
): Promise<StorageKeyStatus> {
  if (fast) return (await ctx.storage.exists(ref.storage_key)) ? 'intact' : 'missing';
  let encrypted: Buffer;
  try {
    encrypted = await ctx.storage.get(ref.storage_key);
  } catch (err) {
    if (is_absent_object_error(err)) return 'missing';
    throw err;
  }
  try {
    const plaintext = ctx.decrypt(encrypted, ref.storage_key);
    const intact =
      plaintext.length === ref.size_bytes &&
      compute_content_digests(ctx, plaintext).checksum === ref.checksum;
    return intact ? 'intact' : 'failed';
  } catch {
    return 'failed';
  }
}

/**
 * Checks the message, hosted, and kept blobs of a list of threads, in order. Stops early when
 * interrupted and reports whether it did.
 */
export async function check_message_blobs(
  ctx: TenantContext,
  refs: TeamsStoredBlobRef[],
  options: VerificationOptions,
  tally: IntegrityTally,
): Promise<boolean> {
  for (const ref of refs) {
    if (options.should_interrupt?.() === true) return true;
    tally.record(ref.storage_key, await blob_status(ctx, ref, options.fast === true));
    emit_progress(options, tally.checked, refs.length);
  }
  return false;
}

/**
 * Loads each channel shard in order and returns the ones that load, so their threads can be
 * checked. A shard is intact when it exists, decrypts, has a readable format version, and
 * names the content it was read from. A shard in a newer format is unsupported, not failed.
 * Stops early when interrupted.
 */
export async function check_channel_shards(
  ctx: TenantContext,
  shards: TeamsChannelShardRepository,
  shard_keys: string[],
  options: VerificationOptions,
  tally: IntegrityTally,
): Promise<{ loaded: TeamsChannelShard[]; interrupted: boolean }> {
  const loaded: TeamsChannelShard[] = [];
  for (const key of shard_keys) {
    if (options.should_interrupt?.() === true) return { loaded, interrupted: true };
    const shard = await load_shard_status(ctx, shards, key, tally);
    if (shard) loaded.push(shard);
    emit_progress(options, tally.checked, shard_keys.length);
  }
  return { loaded, interrupted: false };
}

/** Loads one shard and records its status. Returns the shard only when it is intact. */
async function load_shard_status(
  ctx: TenantContext,
  shards: TeamsChannelShardRepository,
  key: string,
  tally: IntegrityTally,
): Promise<TeamsChannelShard | undefined> {
  if (!(await ctx.storage.exists(key))) {
    tally.record(key, 'missing');
    return undefined;
  }
  try {
    const shard = await shards.load(ctx, key);
    tally.record(key, 'intact');
    return shard;
  } catch (err) {
    if (err instanceof UnsupportedFormatVersionError) {
      tally.record(key, 'unsupported');
      return undefined;
    }
    if (err instanceof UnreadableContentError) {
      tally.record(key, 'failed');
      return undefined;
    }
    throw err;
  }
}

/** Emits one processing progress tick. */
function emit_progress(options: VerificationOptions, processed: number, total: number): void {
  emit_operation_progress(options, {
    operation: 'verify',
    workload: 'teams',
    phase: 'processing',
    processed,
    total,
  });
}
