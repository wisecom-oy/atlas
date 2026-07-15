import type { TransferProgressReporter, TransferProgressUpdate } from '@wisecom/atlas-types';
import type { TransferVerb } from '@/ui/dashboards/transfer-progress';

interface LineRow {
  name: string;
  total_items: number;
  terminal: boolean;
}

/**
 * Non-TTY fallback for save/restore dashboards: one plain log line per
 * finished folder, byte-identical to the pre-Ink output.
 */
export class TransferProgressLineReporter implements TransferProgressReporter {
  private readonly _rows: LineRow[];
  private readonly _verb: TransferVerb;

  constructor(folders: { name: string; total_items: number }[], verb: TransferVerb) {
    this._rows = folders.map((folder) => ({
      name: folder.name,
      total_items: folder.total_items,
      terminal: false,
    }));
    this._verb = verb;
  }

  mark_active(_index: number): void {}

  update_active(_index: number, _update: TransferProgressUpdate): void {}

  mark_done(index: number, transferred: number, attachments: number): void {
    const row = this._rows[index];
    if (!row) return;
    row.terminal = true;

    if (row.total_items === 0) {
      console.log(`  [--] ${row.name} -- 0 items -- skipped`);
      return;
    }
    const att = attachments > 0 ? `, ${attachments} att` : '';
    console.log(`  [ok] ${row.name} -- ${transferred} ${this._verb}${att}`);
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

  show_finalizing(): void {
    console.log('  Finalizing archive...');
  }

  finish(_actual_total?: number): void {}
}
