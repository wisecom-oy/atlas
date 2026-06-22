import chalk from 'chalk';
import { format_duration } from '@wisecom/atlas-core/services/shared/progress-rate';

type FolderStatus = 'pending' | 'active' | 'done' | 'skipped' | 'interrupted' | 'error';

interface FolderRow {
  name: string;
  total_items: number;
  status: FolderStatus;
  processed: number;
  restored: number;
  attachments: number;
  rate: number;
  eta_seconds: number;
  error_message: string;
}

interface TotalRow {
  global_processed: number;
  global_total: number;
  rate: number;
  eta_seconds: number;
}

/**
 * Multi-line ANSI dashboard for restore progress.
 * Shows all folders simultaneously, redrawn in-place each update.
 */
export class RestoreProgressDashboard {
  private readonly _rows: FolderRow[];
  private readonly _total: TotalRow;
  private readonly _is_tty: boolean;
  private _rendered = false;
  private readonly _line_count: number;

  constructor(folders: { name: string; total_items: number }[]) {
    this._is_tty = !!process.stdout.isTTY;
    this._rows = folders.map((f) => ({
      name: f.name,
      total_items: f.total_items,
      status: 'pending',
      processed: 0,
      restored: 0,
      attachments: 0,
      rate: 0,
      eta_seconds: 0,
      error_message: '',
    }));
    this._total = { global_processed: 0, global_total: 0, rate: 0, eta_seconds: 0 };
    this._line_count = this._rows.length + 1;
    this.render();
  }

  mark_active(index: number): void {
    const row = this._rows[index];
    if (!row) return;
    row.status = 'active';
    this.render();
  }

  update_active(
    index: number,
    processed: number,
    restored: number,
    attachments: number,
    rate: number,
    eta_seconds: number,
  ): void {
    const row = this._rows[index];
    if (!row) return;
    row.processed = processed;
    row.restored = restored;
    row.attachments = attachments;
    row.rate = rate;
    row.eta_seconds = eta_seconds;
    this.render();
  }

  mark_done(index: number, restored: number, attachments: number): void {
    const row = this._rows[index];
    if (!row) return;
    row.restored = restored;
    row.attachments = attachments;

    if (row.total_items === 0) {
      row.status = 'skipped';
    } else {
      row.status = 'done';
    }

    if (!this._is_tty) this.log_non_tty(row);
    this.render();
  }

  mark_all_pending_interrupted(): void {
    for (const row of this._rows) {
      if (row.status === 'pending' || row.status === 'active') {
        row.status = 'interrupted';
        if (!this._is_tty) this.log_non_tty(row);
      }
    }
    this.render();
  }

  mark_error(index: number, message: string): void {
    const row = this._rows[index];
    if (!row) return;
    row.status = 'error';
    row.error_message = message;
    if (!this._is_tty) this.log_non_tty(row);
    this.render();
  }

  update_total(
    global_processed: number,
    global_total: number,
    rate: number,
    eta_seconds: number,
  ): void {
    this._total.global_processed = global_processed;
    this._total.global_total = global_total;
    this._total.rate = rate;
    this._total.eta_seconds = eta_seconds;
  }

  finish(actual_total?: number): void {
    if (actual_total !== undefined) {
      this._total.global_processed = actual_total;
      this._total.global_total = actual_total;
    }
    this.render();
  }

  private log_non_tty(row: FolderRow): void {
    if (row.status === 'skipped') {
      console.log(`  [--] ${row.name} -- 0 items -- skipped`);
    } else if (row.status === 'done') {
      const att = row.attachments > 0 ? `, ${row.attachments} att` : '';
      console.log(`  [ok] ${row.name} -- ${row.restored} restored${att}`);
    } else if (row.status === 'interrupted') {
      console.log(`  [~~] ${row.name} -- interrupted`);
    } else if (row.status === 'error') {
      console.log(`  [!!] ${row.name} -- ERROR: ${row.error_message}`);
    }
  }

  private render(): void {
    if (!this._is_tty) return;

    const lines = this._rows.map((r) => format_folder_row(r));
    lines.push(format_total_row(this._total));

    if (this._rendered) {
      process.stdout.write(`\x1b[${this._line_count}A`);
    }

    for (const line of lines) {
      process.stdout.write(`\r  ${line}\x1b[K\n`);
    }

    this._rendered = true;
  }
}

function pad_name(name: string, width = 28): string {
  return name.length > width ? name.slice(0, width - 1) + '~' : name.padEnd(width);
}

function format_folder_row(row: FolderRow): string {
  const name = pad_name(row.name);

  switch (row.status) {
    case 'pending':
      return chalk.gray(`[  ] ${name} ${row.total_items} items`);

    case 'active':
      return chalk.cyan(
        `[>>] ${name} ${row.processed}/${row.total_items}` +
          ` | ${row.rate.toFixed(1)} msg/s` +
          ` | ETA ${format_duration(row.eta_seconds)}`,
      );

    case 'done': {
      const att = row.attachments > 0 ? `, ${row.attachments} att` : '';
      return chalk.green(`[ok] ${name} ${row.restored} restored${att}`);
    }

    case 'skipped':
      return chalk.gray(`[--] ${name} 0 items -- skipped`);

    case 'interrupted':
      return chalk.yellow(`[~~] ${name} -- interrupted`);

    case 'error':
      return chalk.red(`[!!] ${name} ERROR: ${row.error_message}`);
  }
}

function format_total_row(t: TotalRow): string {
  if (t.global_total === 0) {
    return chalk.white('---- TOTAL                          --');
  }
  const done = t.global_processed >= t.global_total;
  const eta_str = done ? 'done' : `ETA ${format_duration(t.eta_seconds)}`;
  return chalk.white(
    `---- TOTAL${' '.repeat(18)} ` +
      `${t.global_processed}/${t.global_total}` +
      ` | ${t.rate.toFixed(1)} msg/s` +
      ` | ${eta_str}`,
  );
}
