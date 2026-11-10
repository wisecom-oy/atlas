import type { DriveDeltaItem } from '@/drive-ports';

/**
 * The kind backup treats a delta item as. Only files are backed up; folders and the drive root
 * are skipped.
 *
 * Graph sends a removed item without its `file` or `folder` facet, so the mapper reports every
 * deletion as a file. The kind the cursor recorded when the item was last seen wins, so deleting
 * a folder is not mistaken for deleting a file. Backup and status share this so that status counts
 * exactly the items a backup would act on (issue #630).
 */
export function resolve_backed_up_kind(
  item: Pick<DriveDeltaItem, 'item_id' | 'kind' | 'deleted'>,
  previous_kind_by_file_id: Readonly<Record<string, 'file' | 'folder'>>,
): 'file' | 'folder' {
  if (!item.deleted || item.kind !== 'file') return item.kind;
  return previous_kind_by_file_id[item.item_id] ?? item.kind;
}
