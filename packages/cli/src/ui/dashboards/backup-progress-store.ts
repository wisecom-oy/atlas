import type { BackupProgressReporter } from '@wisecom/atlas-types';
import { DashboardStore } from '@/ui/dashboards/dashboard-store';

export type FolderStatus =
  'pending' | 'active' | 'paging' | 'done' | 'empty' | 'synced' | 'interrupted' | 'error';

export interface FolderRow {
  name: string;
  total_items: number;
  status: FolderStatus;
  processed: number;
  stored: number;
  deduped: number;
  attachments: number;
  rate: number;
  eta_seconds: number;
  paging_fetched: number;
  paging_rate: number;
  error_message: string;
}

export interface BackupProgressState {
  rows: FolderRow[];
  /** Indexes of rows that reached a terminal state, in completion order. */
  completed_order: number[];
  global_processed: number;
  global_total: number;
  rate: number;
  eta_seconds: number;
  status_message: string;
}

/**
 * Classifies a finished folder: nothing processed and no items = `empty`,
 * nothing processed with items = `synced` (up to date), otherwise `done`.
 */
export function classify_finished_folder(
  row: Pick<FolderRow, 'processed' | 'total_items'>,
  stored: number,
  deduped: number,
): FolderStatus {
  const nothing_processed = row.processed === 0 && stored === 0 && deduped === 0;
  if (nothing_processed && row.total_items === 0) return 'empty';
  if (nothing_processed && row.total_items > 0) return 'synced';
  return 'done';
}

function make_row(folder: { name: string; total_items: number }): FolderRow {
  return {
    name: folder.name,
    total_items: folder.total_items,
    status: 'pending',
    processed: 0,
    stored: 0,
    deduped: 0,
    attachments: 0,
    rate: 0,
    eta_seconds: 0,
    paging_fetched: 0,
    paging_rate: 0,
    error_message: '',
  };
}

/** Translates BackupProgressReporter calls into Ink-consumable state snapshots. */
export class BackupProgressStore
  extends DashboardStore<BackupProgressState>
  implements BackupProgressReporter
{
  constructor(folders: { name: string; total_items: number }[]) {
    super({
      rows: folders.map(make_row),
      completed_order: [],
      global_processed: 0,
      global_total: 0,
      rate: 0,
      eta_seconds: 0,
      status_message: '',
    });
  }

  set_status(message: string): void {
    this.update((draft) => {
      draft.status_message = message;
    });
  }

  mark_active(index: number): void {
    this.mutate_row(index, (row) => {
      row.status = 'active';
    });
  }

  update_active(index: number, processed: number, rate: number, eta_seconds: number): void {
    this.mutate_row(index, (row) => {
      row.processed = processed;
      row.rate = rate;
      row.eta_seconds = eta_seconds;
    });
  }

  update_paging(index: number, items_fetched: number, rate: number, eta_seconds: number): void {
    this.mutate_row(index, (row) => {
      row.status = 'paging';
      row.paging_fetched = items_fetched;
      row.paging_rate = rate;
      row.eta_seconds = eta_seconds;
    });
  }

  mark_done(index: number, stored: number, deduped: number, attachments: number): void {
    this.update((draft) => {
      const row = draft.rows[index];
      if (!row) return;
      const updated = { ...row, stored, deduped, attachments };
      updated.status = classify_finished_folder(row, stored, deduped);
      draft.rows = draft.rows.with(index, updated);
      draft.completed_order = [...draft.completed_order, index];
    });
  }

  mark_all_pending_interrupted(): void {
    this.update((draft) => {
      const interrupted: number[] = [];
      draft.rows = draft.rows.map((row, index) => {
        if (row.status !== 'pending' && row.status !== 'active' && row.status !== 'paging') {
          return row;
        }
        interrupted.push(index);
        return { ...row, status: 'interrupted' as const };
      });
      draft.completed_order = [...draft.completed_order, ...interrupted];
    });
  }

  mark_error(index: number, message: string): void {
    this.update((draft) => {
      const row = draft.rows[index];
      if (!row) return;
      draft.rows = draft.rows.with(index, { ...row, status: 'error', error_message: message });
      draft.completed_order = [...draft.completed_order, index];
    });
  }

  update_total(
    global_processed: number,
    global_total: number,
    rate: number,
    eta_seconds: number,
  ): void {
    this.update((draft) => {
      draft.global_processed = global_processed;
      draft.global_total = global_total;
      draft.rate = rate;
      draft.eta_seconds = eta_seconds;
    });
  }

  finish(actual_total?: number): void {
    if (actual_total === undefined) return;
    this.update((draft) => {
      draft.global_processed = actual_total;
      draft.global_total = actual_total;
    });
  }

  private mutate_row(index: number, mutate: (row: FolderRow) => void): void {
    this.update((draft) => {
      const row = draft.rows[index];
      if (!row) return;
      const updated = { ...row };
      mutate(updated);
      draft.rows = draft.rows.with(index, updated);
    });
  }
}
