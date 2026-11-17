import type { TeamsHostedRef } from '@wisecom/atlas-types';
import type { HostedOwner } from '@/services/backup/hosted-reference-scanner';
import type { SavedHostedFile, ThreadExportContext } from '@/services/save/export-types';
import { hosted_archive_path, inline_image_type } from '@/services/save/hosted-file-path';
import { read_verified_blob } from '@/services/save/message-blob-reader';
import { error_message } from '@/services/shared/error-message';

/**
 * What one message version's hosted contents came to: the files written, the image data URIs the
 * page embeds (keyed by hosted ID), and the IDs the backup never captured.
 */
export interface HostedExport {
  readonly files: SavedHostedFile[];
  readonly data_uris: Map<string, string>;
  readonly missing: string[];
}

/** Names a message in a report line: `message <root>` for a root, `reply <id>` for a reply. */
export function owner_label(owner: HostedOwner): string {
  return owner.reply_id === undefined ? `message ${owner.root_id}` : `reply ${owner.reply_id}`;
}

/**
 * Writes every hosted content of one message version to the archive, one file each, whatever its
 * type, and reads the image ones into data URIs for the page. An item that cannot be read is
 * reported and left out. An item the backup never captured is listed as missing.
 */
export async function export_hosted_contents(
  context: ThreadExportContext,
  owner: HostedOwner,
  hosted: Record<string, TeamsHostedRef>,
  missing: readonly string[],
): Promise<HostedExport> {
  const { ctx, directory, write, tally } = context;
  const label = owner_label(owner);
  const files: SavedHostedFile[] = [];
  const data_uris = new Map<string, string>();
  for (const [id, ref] of Object.entries(hosted)) {
    let bytes: Buffer;
    try {
      bytes = await read_verified_blob(ctx, ref);
    } catch (err) {
      tally.errors.push(`${label}: hosted content ${id}: ${error_message(err)}`);
      continue;
    }
    const path = hosted_archive_path(directory, owner, id, ref.content_type);
    await write(path, bytes);
    tally.hosted_files++;
    files.push({ id, content_type: ref.content_type, path });
    const image_type = inline_image_type(ref.content_type);
    if (image_type !== undefined) {
      data_uris.set(id, `data:${image_type};base64,${bytes.toString('base64')}`);
    }
  }
  for (const id of missing) {
    tally.hosted_missing.push(`${label}: hosted content ${id} was not captured by backup`);
  }
  return { files, data_uris, missing: [...missing] };
}
