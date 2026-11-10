import { once } from 'node:events';
import { Readable } from 'node:stream';
import {
  archive_failure,
  ArchiveDestinationError,
  build_archive_entry_path,
  type FileArchive,
} from '@/services/shared/file-save-zip-writer';

/**
 * A streamed entry failed after the archive had started writing it, so the archive cannot be used.
 *
 * A zip entry cannot be withdrawn once its bytes have been emitted, and an archive whose entry
 * stopped half way never reaches its central directory. The run therefore stops and the archive is
 * aborted, rather than continuing to a file that would look complete (issue #617).
 */
export class ArchiveEntryAbortedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ArchiveEntryAbortedError';
  }
}

/**
 * Appends one entry whose content arrives as chunks, resolving once it has been compressed and the
 * destination has taken what that produced.
 *
 * Memory stays bounded by the stream buffers, because the archiver pulls from `source` only as fast
 * as its destination drains. `source` must throw before it finishes if its content turns out to be
 * bad, which keeps the archiver from closing the entry. Any failure other than a lost destination
 * leaves the archive mid-entry and is raised as an {@link ArchiveEntryAbortedError}.
 *
 * One entry at a time, for the reason {@link append_archive_entry} gives.
 */
export async function append_archive_stream_entry(
  file_archive: FileArchive,
  entry_path: string,
  source: AsyncIterable<Buffer>,
): Promise<void> {
  const failed = archive_failure(file_archive);
  const cancel_wait = new AbortController();
  const written = once(file_archive.archive, 'entry', { signal: cancel_wait.signal });
  const readable = Readable.from(source, { objectMode: false });
  const source_failed = reject_on_stream_error(readable);
  file_archive.archive.append(readable, { name: entry_path });
  try {
    await Promise.race([written, failed, source_failed]);
    await Promise.race([file_archive.drain(), failed]);
  } catch (err) {
    readable.destroy();
    if (err instanceof ArchiveDestinationError) throw err;
    throw new ArchiveEntryAbortedError(
      `The archive was abandoned while writing ${entry_path}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  } finally {
    cancel_wait.abort();
  }
}

/** Adds a streamed file to the archive under the given folder path. */
export async function add_stream_to_archive(
  file_archive: FileArchive,
  folder_path: string,
  file_name: string,
  source: AsyncIterable<Buffer>,
): Promise<void> {
  await append_archive_stream_entry(
    file_archive,
    build_archive_entry_path(folder_path, file_name),
    source,
  );
}

/**
 * Rejects with the first error the stream emits, and never resolves.
 *
 * The listener also keeps a source failure from surfacing as an unhandled `error` event.
 */
function reject_on_stream_error(stream: Readable): Promise<never> {
  const failure = new Promise<never>((_resolve, reject) => {
    stream.once('error', reject);
  });
  failure.catch(() => undefined);
  return failure;
}
