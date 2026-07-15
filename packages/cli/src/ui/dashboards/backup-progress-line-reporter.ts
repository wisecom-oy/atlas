import type { BackupProgressReporter } from '@wisecom/atlas-types';
import { classify_finished_folder } from '@/ui/dashboards/backup-progress-store';

interface LineRow {
  name: string;
  total_items: number;
  processed: number;
  terminal: boolean;
}

/**
 * Non-TTY fallback for the folder backup dashboard: one plain log line per
 * finished folder, byte-identical to the pre-Ink output so cron/CI log
 * scrapers keep working.
 */
export class BackupProgressLineReporter implements BackupProgressReporter {
  private readonly _rows: LineRow[];

  constructor(folders: { name: string; total_items: number }[]) {
    this._rows = folders.map((folder) => ({
      name: folder.name,
      total_items: folder.total_items,
      processed: 0,
      terminal: false,
    }));
  }

  set_status(_message: string): void {}

  mark_active(_index: number): void {}

  update_active(index: number, processed: number, _rate: number, _eta_seconds: number): void {
    const row = this._rows[index];
    if (row) row.processed = processed;
  }

  update_paging(
    _index: number,
    _items_fetched: number,
    _rate: number,
    _eta_seconds: number,
  ): void {}

  mark_done(index: number, stored: number, deduped: number, _attachments: number): void {
    const row = this._rows[index];
    if (!row) return;
    row.terminal = true;

    const status = classify_finished_folder(row, stored, deduped);
    if (status === 'empty') {
      console.log(`  [--] ${row.name} -- 0 items -- empty`);
    } else if (status === 'synced') {
      console.log(`  [==] ${row.name} -- ${row.total_items} items -- up to date`);
    } else {
      console.log(`  [ok] ${row.name} -- ${stored} stored, ${deduped} dedup`);
    }
  }

  mark_all_pending_interrupted(): void {
    for (const row of this._rows) {
      if (row.terminal) continue;
      row.terminal = true;
      console.log(`  [~~] ${row.name} -- interrupted`);
    }
  }

  mark_error(index: number, message: string): void {
    const row = this._rows[index];
    if (!row) return;
    row.terminal = true;
    console.log(`  [!!] ${row.name} -- ERROR: ${message}`);
  }

  update_total(
    _global_processed: number,
    _global_total: number,
    _rate: number,
    _eta_seconds: number,
  ): void {}

  finish(_actual_total?: number): void {}
}
