import chalk from 'chalk';
import { format_duration } from '@/services/shared/progress-rate';

type FolderStatus = 'pending' | 'active' | 'done' | 'skipped' | 'interrupted' | 'error';

interface FolderRow {
  name: string;
  total_items: number;
  status: FolderStatus;
  saved: number;
  attachments: number;
  integrity_ok: number;
  integrity_fail: number;
  rate: number;
  eta_seconds: number;
  error_message: string;
}

interface TotalRow {
  global_processed: number;
  global_total: number;
  rate: number;
  eta_seconds: number;
  finalizing: boolean;
}

/**
 * Multi-line ANSI dashboard for save-to-zip progress.
 * Shows all folders simultaneously, redrawn in-place each update.
 */
export class SaveProgressDashboard {
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
      saved: 0,
      attachments: 0,
      integrity_ok: 0,
      integrity_fail: 0,
      rate: 0,
      eta_seconds: 0,
      error_message: '',
    }));
    this._total = {
      global_processed: 0,
      global_total: 0,
      rate: 0,
      eta_seconds: 0,
      finalizing: false,
    };
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
    saved: number,
    attachments: number,
    integrity_ok: number,
    integrity_fail: number,
    rate: number,
    eta_seconds: number,
  ): void {
    const row = this._rows[index];
    if (!row) return;
    row.saved = saved;
    row.attachments = attachments;
    row.integrity_ok = integrity_ok;
    row.integrity_fail = integrity_fail;
    row.rate = rate;
    row.eta_seconds = eta_seconds;
    this.render();
  }

  mark_done(index: number, saved: number, attachments: number): void {
    const row = this._rows[index];
    if (!row) return;
    row.saved = saved;
    row.attachments = attachments;
    row.status = row.total_items === 0 ? 'skipped' : 'done';
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

  finish(): void {
    this._total.finalizing = false;
    this.render();
  }

  /** Switches the TOTAL row to a "finalizing" state while the archive is closed. */
  show_finalizing(): void {
    this._total.finalizing = true;
    if (!this._is_tty) {
      console.log(chalk.blue('[*]'), 'Finalizing archive...');
    }
    this.render();
  }

  private log_non_tty(row: FolderRow): void {
    if (row.status === 'skipped') {
      console.log(`  [--] ${row.name} -- 0 items -- skipped`);
    } else if (row.status === 'done') {
      const att = row.attachments > 0 ? `, ${row.attachments} att` : '';
      const fail = row.integrity_fail > 0 ? chalk.red(` (${row.integrity_fail} failed)`) : '';
      console.log(`  [ok] ${row.name} -- ${row.saved} saved${att}${fail}`);
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

    case 'active': {
      const fail = row.integrity_fail > 0 ? chalk.red(` ${row.integrity_fail}!`) : '';
      return chalk.cyan(
        `[>>] ${name} ${row.saved}/${row.total_items}${fail}` +
          ` | ${row.rate.toFixed(1)} msg/s` +
          ` | ETA ${format_duration(row.eta_seconds)}`,
      );
    }

    case 'done': {
      const att = row.attachments > 0 ? `, ${row.attachments} att` : '';
      const fail = row.integrity_fail > 0 ? chalk.red(` (${row.integrity_fail} failed)`) : '';
      return chalk.green(`[ok] ${name} ${row.saved} saved${att}${fail}`);
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
  if (t.finalizing) {
    return chalk.white(
      `---- TOTAL${' '.repeat(18)} ` +
        `${t.global_processed}/${t.global_total}` +
        ` | finalizing...`,
    );
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
