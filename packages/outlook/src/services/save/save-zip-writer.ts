import { type Archiver } from 'archiver';
import {
  append_archive_entry,
  create_file_archive,
} from '@wisecom/atlas-core/services/shared/file-save-zip-writer';
import type { ArchiveTarget } from '@wisecom/atlas-core/services/shared/file-save-zip-writer';

export type { ArchiveTarget };

export interface SaveArchive {
  readonly archive: ArchiveWriter;
  readonly promise: Promise<number>;
  /** Resolves once the destination has taken what the archive has produced so far. */
  drain(): Promise<void>;
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
  return create_file_archive(target, { compression_level: 9 });
}

/**
 * Appends an EML buffer and waits for it to be compressed and taken by the destination.
 *
 * `archiver.append()` only queues, so without waiting the loop in save-entry-processor would
 * download the next message from S3 immediately and the queue, and the archive's readable buffer,
 * would grow without bound. For a 500 GB mailbox that means OOM long before the archive is
 * finished. Waiting keeps peak memory at roughly one message and its attachments.
 */
export function add_eml_to_archive(
  save_archive: SaveArchive,
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
  return append_archive_entry(
    save_archive,
    `${dir_path}/${sanitize_path_segment(filename)}`,
    content,
  );
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
