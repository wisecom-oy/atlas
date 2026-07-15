import type { TransferProgressReporter, TransferProgressUpdate } from '@wisecom/atlas-types';
import { DashboardStore } from '@/ui/dashboards/dashboard-store';

export type TransferRowStatus = 'pending' | 'active' | 'done' | 'skipped' | 'interrupted' | 'error';

export interface TransferRow {
  name: string;
  total_items: number;
  status: TransferRowStatus;
  transferred: number;
  attachments: number;
  integrity_fail: number;
  rate: number;
  eta_seconds: number;
  error_message: string;
}

export interface TransferProgressState {
  rows: TransferRow[];
  /** Indexes of rows that reached a terminal state, in completion order. */
  completed_order: number[];
  global_processed: number;
  global_total: number;
  rate: number;
  eta_seconds: number;
  finalizing: boolean;
}

/** Translates TransferProgressReporter calls into Ink-consumable state snapshots. */
export class TransferProgressStore
  extends DashboardStore<TransferProgressState>
  implements TransferProgressReporter
{
  constructor(folders: { name: string; total_items: number }[]) {
    super({
      rows: folders.map((folder) => ({
        name: folder.name,
        total_items: folder.total_items,
        status: 'pending' as const,
        transferred: 0,
        attachments: 0,
        integrity_fail: 0,
        rate: 0,
        eta_seconds: 0,
        error_message: '',
      })),
      completed_order: [],
      global_processed: 0,
      global_total: 0,
      rate: 0,
      eta_seconds: 0,
      finalizing: false,
    });
  }

  mark_active(index: number): void {
    this.mutate_row(index, (row) => {
      row.status = 'active';
    });
  }

  update_active(index: number, update: TransferProgressUpdate): void {
    this.mutate_row(index, (row) => {
      row.transferred = update.transferred;
      row.attachments = update.attachments;
      row.integrity_fail = update.integrity_fail ?? 0;
      row.rate = update.rate;
      row.eta_seconds = update.eta_seconds;
    });
  }

  mark_done(index: number, transferred: number, attachments: number): void {
    this.update((draft) => {
      const row = draft.rows[index];
      if (!row) return;
      draft.rows = draft.rows.with(index, {
        ...row,
        transferred,
        attachments,
        status: row.total_items === 0 ? 'skipped' : 'done',
      });
      draft.completed_order = [...draft.completed_order, index];
    });
  }

  mark_all_pending_interrupted(): void {
    this.update((draft) => {
      const interrupted: number[] = [];
      draft.rows = draft.rows.map((row, index) => {
        if (row.status !== 'pending' && row.status !== 'active') return row;
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

  show_finalizing(): void {
    this.update((draft) => {
      draft.finalizing = true;
    });
  }

  finish(actual_total?: number): void {
    this.update((draft) => {
      draft.finalizing = false;
      if (actual_total !== undefined) {
        draft.global_processed = actual_total;
        draft.global_total = actual_total;
      }
    });
  }

  private mutate_row(index: number, mutate: (row: TransferRow) => void): void {
    this.update((draft) => {
      const row = draft.rows[index];
      if (!row) return;
      const updated = { ...row };
      mutate(updated);
      draft.rows = draft.rows.with(index, updated);
    });
  }
}
