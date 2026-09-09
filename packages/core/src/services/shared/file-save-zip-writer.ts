import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import type { Writable } from 'node:stream';
import { ZipArchive, type Archiver } from 'archiver';
import { logger } from '@/utils/logger';

/** The archiver instance file entries are appended to. */
export type FileArchiveWriter = Archiver;

/**
 * Where a save archive is written: a filesystem path, or a caller's stream.
 *
 * A stream target exports without touching local disk, which is what an embedder piping to an
 * HTTP response or an upload needs (issue #44). It also has no staging step, because there is no
 * path to move the bytes onto.
 */
export type ArchiveTarget = string | Writable;

export interface FileArchive {
  readonly archive: FileArchiveWriter;
  readonly promise: Promise<number>;
  /**
   * Resolves once the destination has taken what the archive has produced so far.
   *
   * The archiver keeps compressing whatever it is handed, so without this a producer runs as far
   * ahead of a slow consumer as its source allows and the difference sits in the archive's readable
   * buffer (issue #343).
   */
  drain(): Promise<void>;
  /**
   * Makes the completed archive available to its consumer. For a path target this moves the
   * finished archive onto the output path, which is untouched until then. For a stream target the
   * bytes were already delivered as they were written, so there is nothing left to do.
   *
   * Call it after the archive is finalized and the byte count has resolved.
   */
  publish(): Promise<void>;
  /**
   * Tears down a run that failed before publishing.
   *
   * A path target loses its temporary file and leaves any pre-existing file at the output path
   * intact. A stream target is destroyed, so a consumer sees a failed transfer rather than a
   * truncated archive delivered as a success.
   */
  abort(): Promise<void>;
}

/**
 * Creates a zip archive for the given target. Returns the archiver and a promise that
 * resolves with total bytes written.
 *
 * Entries bound for a path are written to a sibling temporary file and moved onto the output path
 * by {@link FileArchive.publish}, so nothing appears there until the archive is complete. A
 * truncated zip is indistinguishable from a finished one, which is worse than no file at all when
 * the reason an operator ran a save is that they need the bytes (issue #307), and a save that
 * fails must not destroy a file that was already sitting at the path it was pointed at.
 *
 * A stream target cannot stage: its consumer receives bytes as they are produced, which is the
 * point of streaming an export. `abort()` therefore destroys it instead.
 */
export function create_file_archive(
  target: ArchiveTarget,
  options: { readonly compression_level?: number } = {},
): FileArchive {
  const staging_path =
    typeof target === 'string' ? `${target}.part-${randomBytes(6).toString('hex')}` : undefined;
  const output =
    staging_path === undefined ? (target as Writable) : createWriteStream(staging_path);
  const archive = new ZipArchive({ zlib: { level: options.compression_level ?? 6 } });

  const promise = new Promise<number>((resolve, reject) => {
    // A staged file is only safe to rename once its descriptor is closed. A caller's stream may
    // never emit `close` at all, so for those the flush is what completion means.
    output.on(staging_path === undefined ? 'finish' : 'close', () => resolve(archive.pointer()));
    archive.on('error', reject);
    // Errors on the destination are not forwarded through pipe(), so without this a failed write
    // resolves on `close` and the caller reports a successful save.
    output.on('error', reject);
  });
  // Attach a handler now, so an error raised while entries are still being written is not an
  // unhandled rejection. Awaiting `promise` later still sees the rejection.
  promise.catch(() => undefined);

  archive.pipe(output);
  return {
    archive,
    promise,
    drain: () => wait_for_drain(output),
    publish: async () => {
      if (staging_path !== undefined) await rename(staging_path, target as string);
    },
    abort: () => abort_archive(archive, output, staging_path),
  };
}

/**
 * Waits until the destination is ready for more, or until it is gone.
 *
 * A destination that is destroyed mid-export never emits `drain`, and a producer parked on that
 * event would wait forever instead of failing; the actual failure is delivered through the
 * archive's byte-count promise.
 */
async function wait_for_drain(output: Writable): Promise<void> {
  if (!output.writableNeedDrain || output.destroyed || output.writableEnded) return;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const settle = (err?: Error): void => {
    output.off('drain', on_drain);
    output.off('close', on_close);
    output.off('error', on_error);
    if (err === undefined) resolve();
    else reject(err);
  };
  const on_drain = (): void => settle();
  const on_close = (): void => settle();
  const on_error = (err: Error): void => settle(err);
  output.once('drain', on_drain);
  output.once('close', on_close);
  output.once('error', on_error);
  await promise;
}

async function abort_archive(
  archive: FileArchiveWriter,
  output: Writable,
  staging_path: string | undefined,
): Promise<void> {
  try {
    archive.abort();
  } catch {
    // Already destroyed or never started; the stream teardown below is what matters.
  }
  output.destroy();
  if (staging_path === undefined) return;
  try {
    await rm(staging_path, { force: true });
  } catch (err) {
    logger.warn(
      `Could not remove the partial archive at ${staging_path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Appends one entry at the given path in the archive, resolving once it has been compressed and
 * the destination has taken what that produced.
 *
 * `append()` only queues, so awaiting it alone let a producer run as far ahead of a slow
 * destination as the source allowed: an export to a stalled consumer compressed every entry it
 * could decrypt and the result sat in the archive's readable buffer (issue #343). Waiting for the
 * archiver's `entry` event bounds the queue and {@link FileArchive.drain} bounds the buffer.
 *
 * A destination that fails is raised here rather than waited on. Its error lands on the byte-count
 * promise, not on the archiver, and an archive that lost its destination stops emitting `entry`
 * altogether: a disk filling up mid-export would otherwise park the producer forever.
 *
 * One entry at a time. The `entry` event names no correlation, so a caller appending two entries
 * concurrently would pair each wait with whichever finished first.
 *
 * Callers own the entry path, because what makes one safe differs by workload: a drive export
 * carries a folder path the provider already validated, and a mail export builds one from a
 * subject the sender chose.
 */
export async function append_archive_entry(
  file_archive: FileArchive,
  entry_path: string,
  content: Buffer,
): Promise<void> {
  const failed = archive_failure(file_archive);
  // A save keeps going after a per-entry failure, so an abandoned waiter would add a listener pair
  // to the archiver for every entry left in the run.
  const cancel_wait = new AbortController();
  const written = once(file_archive.archive, 'entry', { signal: cancel_wait.signal });
  file_archive.archive.append(content, { name: entry_path });
  try {
    await Promise.race([written, failed]);
    await Promise.race([file_archive.drain(), failed]);
  } finally {
    cancel_wait.abort();
  }
}

/** Rejects with whatever failed the archive, and never resolves, so it can only lose a race. */
function archive_failure(file_archive: FileArchive): Promise<never> {
  return file_archive.promise.then(
    () => new Promise<never>(() => undefined),
    (err: unknown) => {
      throw err instanceof Error ? err : new Error(String(err));
    },
  );
}

/** Adds a file to the archive under the given folder path. */
export async function add_file_to_archive(
  file_archive: FileArchive,
  folder_path: string,
  file_name: string,
  content: Buffer,
): Promise<void> {
  const normalized =
    folder_path === '/' || folder_path === '' ? '' : folder_path.replace(/^\//, '');
  await append_archive_entry(
    file_archive,
    normalized ? `${normalized}/${file_name}` : file_name,
    content,
  );
}

/** Finalizes the archive (must be called after all files are added). */
export async function finalize_file_archive(archive: FileArchiveWriter): Promise<void> {
  await archive.finalize();
}
