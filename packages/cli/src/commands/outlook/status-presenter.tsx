import type { FolderStatus, MailboxStatusResult } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core';
import { DataTable, type TableColumn } from '@/ui/components/data-table';
import { render_static_view } from '@/ui/render';

interface FolderStatusRow {
  folder: string;
  status: string;
  status_color: string;
  pending: string;
  pending_color: string;
}

/** Formats a pending count, marking a lower bound with `+`. */
function format_pending(count: number, capped: boolean): string {
  return capped ? `${count}+` : String(count);
}

/** Derives the status/pending cells and their colors for one folder. */
function build_folder_status_row(f: FolderStatus): FolderStatusRow {
  if (!f.has_backup) {
    return {
      folder: f.folder_name,
      status: 'never backed up',
      status_color: 'yellow',
      pending: '-',
      pending_color: 'gray',
    };
  }
  if (f.peek_error !== undefined) {
    return {
      folder: f.folder_name,
      status: 'peek failed',
      status_color: 'red',
      pending: '?',
      pending_color: 'gray',
    };
  }
  const total = format_pending(f.pending_new + f.pending_removed, f.pending_capped);
  return {
    folder: f.folder_name,
    status: f.is_up_to_date ? 'up-to-date' : `${total} change(s)`,
    status_color: f.is_up_to_date ? 'green' : 'red',
    pending: total,
    pending_color: f.is_up_to_date ? 'green' : 'red',
  };
}

/** Prints the last backup, a per-folder table, any peek failures, and an overall verdict. */
export async function print_mailbox_status(result: MailboxStatusResult): Promise<void> {
  if (result.last_backup_at) {
    const ts = result.last_backup_at.toISOString().replace('T', ' ').slice(0, 16);
    logger.info(`Last backup: ${ts} (${result.last_snapshot_id ?? 'unknown'})\n`);
  } else {
    logger.warn('No previous backup found for this mailbox.\n');
  }

  const columns: TableColumn<FolderStatusRow>[] = [
    { key: 'folder', header: 'Folder', max_width: 26 },
    { key: 'status', header: 'Status', color: (row) => row.status_color },
    { key: 'pending', header: 'Pending', color: (row) => row.pending_color },
  ];
  await render_static_view(
    <DataTable columns={columns} rows={result.folders.map(build_folder_status_row)} />,
  );

  for (const f of result.folders) {
    if (f.peek_error !== undefined) logger.warn(`${f.folder_name}: ${f.peek_error}`);
  }
  print_mailbox_verdict(result);
}

function print_mailbox_verdict(result: MailboxStatusResult): void {
  if (result.is_up_to_date) {
    logger.success('Mailbox is up to date -- no pending changes.');
    return;
  }
  const changes = result.total_pending_changes;
  const not_backed_up = result.folders.filter((f) => !f.has_backup).length;
  const failed_peeks = result.folders.filter((f) => f.peek_error !== undefined).length;
  const parts: string[] = [];
  if (changes > 0) {
    parts.push(`${format_pending(changes, result.pending_capped)} pending change(s)`);
  }
  if (not_backed_up > 0) parts.push(`${not_backed_up} folder(s) never backed up`);
  if (failed_peeks > 0) parts.push(`${failed_peeks} folder(s) could not be checked`);
  logger.info(`Overall: ${parts.join(', ')} across ${result.total_folders} folder(s)`);
}
