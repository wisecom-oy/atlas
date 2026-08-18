import type { BackupProgressReporter } from '@wisecom/atlas-types';
import { calc_rate } from '@wisecom/atlas-core/services/shared/progress-rate';

/** Mutable counters shared across all drives of one scan. */
export interface ScanProgressTotals {
  processed: number;
  total: number;
  started_at: number;
}

/** Builds the per-item callback that feeds row and TOTAL progress updates. */
export function make_item_progress_callback(
  progress: BackupProgressReporter | undefined,
  index: number,
  totals: ScanProgressTotals,
): () => void {
  let drive_processed = 0;
  return () => {
    drive_processed += 1;
    totals.processed += 1;
    const rate = calc_rate(totals.processed, Date.now() - totals.started_at);
    const eta = rate > 0 ? Math.max(0, (totals.total - totals.processed) / rate) : 0;
    progress?.update_active(index, drive_processed, rate, eta);
    progress?.update_total(totals.processed, totals.total, rate, eta);
  };
}

/** Reports a successful drive: `synced` for a no-change incremental delta, `done` otherwise. */
export function report_drive_success(
  progress: BackupProgressReporter | undefined,
  index: number,
  no_changes: boolean,
  counters: { files_stored: number; files_deduplicated: number },
  versions_delta: number,
): void {
  if (!progress) return;
  if (no_changes) {
    progress.mark_synced?.(index);
    return;
  }
  progress.mark_done(index, counters.files_stored, counters.files_deduplicated, versions_delta);
}
