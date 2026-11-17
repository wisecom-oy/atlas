import { logger } from '@wisecom/atlas-core';
import { DataTable, type TableColumn } from '@/ui/components/data-table';
import { render_static_view } from '@/ui/render';

/** One drive or document library in a status report. */
export interface DriveStatusItem {
  readonly drive_name: string;
  readonly has_backup: boolean;
  readonly pending_changes: number;
  readonly failed_items: number;
  readonly is_up_to_date: boolean;
  readonly peek_error?: string | undefined;
}

/** Workload-agnostic shape of a OneDrive or SharePoint status result. */
export interface DriveStatusReport {
  readonly scope_label: string;
  readonly item_label: string;
  readonly last_backup_at: Date | undefined;
  readonly last_snapshot_id: string | undefined;
  readonly is_up_to_date: boolean;
  readonly total_pending_changes: number;
  readonly total_failed_items: number;
  readonly items: readonly DriveStatusItem[];
}

interface DriveStatusRow {
  name: string;
  status: string;
  status_color: string;
  pending: string;
  pending_color: string;
  failed: string;
  failed_color: string;
}

/** Prints the last backup, a per-drive table, and an overall verdict. */
export async function print_drive_status(report: DriveStatusReport): Promise<void> {
  if (report.last_backup_at) {
    const ts = report.last_backup_at.toISOString().replace('T', ' ').slice(0, 16);
    logger.info(`Last backup: ${ts} (${report.last_snapshot_id ?? 'unknown'})\n`);
  } else {
    logger.warn(`No previous backup found for this ${report.scope_label}.\n`);
  }

  const columns: TableColumn<DriveStatusRow>[] = [
    { key: 'name', header: report.item_label, max_width: 30 },
    { key: 'status', header: 'Status', color: (row) => row.status_color },
    { key: 'pending', header: 'Pending', color: (row) => row.pending_color },
    { key: 'failed', header: 'Failed', color: (row) => row.failed_color },
  ];
  await render_static_view(
    <DataTable columns={columns} rows={report.items.map(build_drive_status_row)} />,
  );

  for (const item of report.items) {
    if (item.peek_error !== undefined) logger.warn(`${item.drive_name}: ${item.peek_error}`);
  }
  print_verdict(report);
}

/** Derives the status, pending and failed cells, and their colors, for one drive. */
function build_drive_status_row(item: DriveStatusItem): DriveStatusRow {
  const failed = {
    failed: String(item.failed_items),
    failed_color: item.failed_items === 0 ? 'green' : 'red',
  };
  if (!item.has_backup) {
    return {
      name: item.drive_name,
      status: 'never backed up',
      status_color: 'yellow',
      pending: '-',
      pending_color: 'gray',
      ...failed,
    };
  }
  return {
    name: item.drive_name,
    status: describe_drive_state(item),
    status_color: item.is_up_to_date ? 'green' : 'red',
    ...(item.peek_error === undefined
      ? {
          pending: String(item.pending_changes),
          pending_color: item.pending_changes === 0 ? 'green' : 'red',
        }
      : { pending: '?', pending_color: 'gray' }),
    ...failed,
  };
}

/** The status cell for a drive that has a backup. */
function describe_drive_state(item: DriveStatusItem): string {
  if (item.peek_error !== undefined) return 'peek failed';
  if (item.is_up_to_date) return 'up-to-date';
  if (item.pending_changes > 0) return `${item.pending_changes} change(s)`;
  return `${item.failed_items} failed`;
}

function print_verdict(report: DriveStatusReport): void {
  if (report.is_up_to_date) {
    const scope = report.scope_label;
    logger.success(
      `${scope.charAt(0).toUpperCase()}${scope.slice(1)} is up to date -- no pending changes.`,
    );
    return;
  }

  const never_backed_up = report.items.filter((item) => !item.has_backup).length;
  const parts: string[] = [];
  if (report.total_pending_changes > 0) {
    parts.push(`${report.total_pending_changes} pending change(s)`);
  }
  if (report.total_failed_items > 0) {
    parts.push(`${report.total_failed_items} failed item(s) awaiting retry or skipped`);
  }
  if (never_backed_up > 0) {
    parts.push(`${never_backed_up} ${report.item_label.toLowerCase()}(s) never backed up`);
  }
  const failed_peeks = report.items.filter((item) => item.peek_error !== undefined).length;
  if (failed_peeks > 0) {
    parts.push(`${failed_peeks} ${report.item_label.toLowerCase()}(s) could not be checked`);
  }
  logger.info(
    `Overall: ${parts.join(', ')} across ${report.items.length} ${report.item_label.toLowerCase()}(s)`,
  );
}
