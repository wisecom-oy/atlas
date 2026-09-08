import { type Archiver } from 'archiver';
import { create_file_archive } from '@wisecom/atlas-core/services/shared/file-save-zip-writer';
import type { ArchiveTarget } from '@wisecom/atlas-core/services/shared/file-save-zip-writer';

export type { ArchiveTarget };

export interface SaveArchive {
  readonly archive: ArchiveWriter;
  readonly promise: Promise<number>;
  /**
   * Makes the completed archive available: a rename onto the output path for a file target,
   * nothing for a stream target, whose consumer already has the bytes.
   */
  publish(): Promise<void>;
  /** Discards a run that failed before publishing, leaving no partial archive behind. */
  abort(): Promise<void>;
}

/** The archiver instance EML entries are appended to. */
export type ArchiveWriter = Archiver;

/**
 * Creates a zip archive with maximum compression for the given target.
 *
 * For a path target, streams to a sibling temporary file and publishes it via rename (issue #307).
 * For a stream target, pipes directly to the caller's Writable without staging.
 */
export function create_save_archive(target: ArchiveTarget): SaveArchive {
  const { archive, promise, publish, abort } = create_file_archive(target, {
    compression_level: 9,
  });
  return { archive, promise, publish, abort };
}

/**
 * Appends an EML buffer and waits for it to be compressed and flushed.
 *
 * Backpressure: archiver.append() is fire-and-forget — it queues the buffer
 * internally and compresses in the background. Without waiting, the loop in
 * save-entry-processor would download the next message from S3 immediately,
 * causing the queue (and heap) to grow without bound. For a 500 GB mailbox
 * that means OOM long before the archive is finished.
 *
 * By awaiting the 'entry' event we guarantee each EML is compressed and
 * written to the output stream before the next S3 download starts, keeping
 * peak memory at roughly one message + its attachments.
 */
export function add_eml_to_archive(
  archive: ArchiveWriter,
  folder_path: string,
  filename: string,
  content: Buffer,
): Promise<void> {
  // Nested mail folders become nested zip directories; each level is sanitized
  // on its own so the separator survives while illegal characters do not.
  //
  // The file name is sanitized here too, not just by the caller. It derives from a
  // message subject, which is chosen by whoever sent the mail, and an entry path like
  // `../../../.ssh/authorized_keys` escapes the destination directory in any extractor
  // that honours entry paths. Today's callers pass a name that is already safe, so this
  // changes no existing archive; it means a future caller passing an item or attachment
  // name cannot reintroduce the traversal (issue #258).
  const dir_path = folder_path.split('/').map(sanitize_path_segment).join('/');
  const entry_path = `${dir_path}/${sanitize_path_segment(filename)}`;
  return new Promise<void>((resolve, reject) => {
    const on_entry = (): void => {
      archive.removeListener('error', on_error);
      resolve();
    };
    const on_error = (err: Error): void => {
      archive.removeListener('entry', on_entry);
      reject(err);
    };
    archive.once('entry', on_entry);
    archive.once('error', on_error);
    archive.append(content, { name: entry_path });
  });
}

/** Finalizes the archive. The returned promise resolves to total bytes written. */
export async function finalize_archive(archive: ArchiveWriter): Promise<void> {
  await archive.finalize();
}

function sanitize_path_segment(segment: string): string {
  return (
    segment
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\.{2,}/g, '.')
      .replace(/^\.+|\.+$/g, '') || 'Unknown'
  );
}
