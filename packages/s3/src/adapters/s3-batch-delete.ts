import { createHash } from 'node:crypto';
import {
  DeleteObjectsCommand,
  type DeleteObjectsCommandOutput,
  type S3Client,
} from '@aws-sdk/client-s3';
import { logger } from '@wisecom/atlas-core';
import { ObjectLockRetainedError } from '@wisecom/atlas-types';
import type { StorageDeleteOutcome, StorageDeleteTarget } from '@wisecom/atlas-types';
import { is_bulk_delete_unsupported, is_object_lock_refusal } from '@/adapters/s3-error-classifier';

/** Most keys one `DeleteObjects` request may carry. */
export const DELETE_OBJECTS_LIMIT = 1000;

/** Single deletes in flight per batch once a bucket has fallen back from `DeleteObjects`. */
export const SINGLE_DELETE_CONCURRENCY = 4;

/** Deletes one target by itself; rejects with `ObjectLockRetainedError` on a retention refusal. */
export type SingleDelete = (target: StorageDeleteTarget) => Promise<void>;

/**
 * Deletes targets with `DeleteObjects`, and falls back to one delete per target for good once the
 * backend shows it does not take the bulk request (see `is_bulk_delete_unsupported`).
 */
export class S3BatchDeleter {
  private _bulk_supported = true;

  constructor(
    private readonly _client: S3Client,
    private readonly _bucket: string,
    private readonly _delete_single: SingleDelete,
  ) {}

  /** Deletes every target and returns one outcome per target, in the order given. */
  async delete_batch(targets: readonly StorageDeleteTarget[]): Promise<StorageDeleteOutcome[]> {
    const outcomes: StorageDeleteOutcome[] = [];
    for (let start = 0; start < targets.length; start += DELETE_OBJECTS_LIMIT) {
      const chunk = targets.slice(start, start + DELETE_OBJECTS_LIMIT);
      for (const outcome of await this.delete_chunk(chunk)) outcomes.push(outcome);
    }
    return outcomes;
  }

  private async delete_chunk(
    targets: readonly StorageDeleteTarget[],
  ): Promise<StorageDeleteOutcome[]> {
    if (!this._bulk_supported) return this.delete_singly(targets);
    try {
      return await send_delete_objects(this._client, this._bucket, targets);
    } catch (err) {
      if (!is_bulk_delete_unsupported(err)) throw err;
      this.stop_bulk_deletes(err);
      return this.delete_singly(targets);
    }
  }

  private stop_bulk_deletes(err: unknown): void {
    if (!this._bulk_supported) return;
    this._bulk_supported = false;
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    logger.warn(
      `Bucket "${this._bucket}" refused DeleteObjects (${reason}); deleting one object per request`,
    );
  }

  private delete_singly(targets: readonly StorageDeleteTarget[]): Promise<StorageDeleteOutcome[]> {
    return map_with_concurrency(targets, SINGLE_DELETE_CONCURRENCY, (target) =>
      single_delete_outcome(this._delete_single, target),
    );
  }
}

/**
 * Sends one `DeleteObjects` request and maps each target onto its outcome.
 *
 * The SDK adds a CRC32 checksum header on its own; the request also carries Content-MD5, which
 * older S3-compatible backends require on this call and which AWS accepts alongside it.
 * `Quiet` is off so every deletion is confirmed by name: a target the response does not mention
 * is counted as failed, never assumed gone.
 */
export async function send_delete_objects(
  client: S3Client,
  bucket: string,
  targets: readonly StorageDeleteTarget[],
): Promise<StorageDeleteOutcome[]> {
  const command = new DeleteObjectsCommand({
    Bucket: bucket,
    Delete: {
      Objects: targets.map((target) => ({
        Key: target.key,
        ...(target.version_id !== undefined ? { VersionId: target.version_id } : {}),
      })),
      Quiet: false,
    },
  });
  add_content_md5(command);
  const response = await client.send(command);
  return outcomes_of(targets, response);
}

function outcomes_of(
  targets: readonly StorageDeleteTarget[],
  response: DeleteObjectsCommandOutput,
): StorageDeleteOutcome[] {
  const reported = new Map<string, StorageDeleteOutcome>();
  for (const deleted of response.Deleted ?? []) {
    if (deleted.Key) reported.set(entry_id(deleted.Key, deleted.VersionId), 'deleted');
  }
  for (const error of response.Errors ?? []) {
    if (error.Key) reported.set(entry_id(error.Key, error.VersionId), refusal_outcome(error));
  }
  return targets.map((target) => reported.get(entry_id(target.key, target.version_id)) ?? 'failed');
}

/** A retention refusal is `retained`; any other per-key error, a bare AccessDenied included, failed. */
function refusal_outcome(error: {
  Code?: string | undefined;
  Message?: string | undefined;
}): StorageDeleteOutcome {
  const as_error = Object.assign(new Error(error.Message ?? ''), { name: error.Code ?? 'Error' });
  return is_object_lock_refusal(as_error) ? 'retained' : 'failed';
}

function entry_id(key: string, version_id: string | undefined): string {
  return `${key}\u0000${version_id ?? ''}`;
}

async function single_delete_outcome(
  delete_single: SingleDelete,
  target: StorageDeleteTarget,
): Promise<StorageDeleteOutcome> {
  try {
    await delete_single(target);
    return 'deleted';
  } catch (err) {
    return err instanceof ObjectLockRetainedError ? 'retained' : 'failed';
  }
}

/** Maps every item with at most `limit` calls in flight, keeping the input order. */
async function map_with_concurrency<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const run_worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run_worker));
  return results;
}

/** Injects a Content-MD5 header computed over the serialized request body. */
function add_content_md5(command: DeleteObjectsCommand): void {
  command.middlewareStack.add(
    (next) => async (args) => {
      const request = (args as { request: { body: string; headers: Record<string, string> } })
        .request;
      request.headers['content-md5'] = createHash('md5').update(request.body).digest('base64');
      return next(args);
    },
    { step: 'build', name: 'atlasContentMd5' },
  );
}
