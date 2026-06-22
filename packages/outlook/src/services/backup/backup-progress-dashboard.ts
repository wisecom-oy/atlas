import chalk from 'chalk';
import { format_duration } from '@wisecom/atlas-core/services/shared/progress-rate';
import type { BackupProgressReporter } from '@wisecom/atlas-types';

interface FolderRow {
  name: string;
  total_items: number;
  status: 'pending' | 'active' | 'paging' | 'done' | 'empty' | 'synced' | 'interrupted' | 'error';
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

interface TotalRow {
  global_processed: number;
  global_total: number;
  rate: number;
  eta_seconds: number;
}

/**
 * Multi-line dashboard that renders all folders simultaneously.
 * Uses ANSI escape codes to redraw the block in-place on each update.
 */
export class BackupProgressDashboard implements BackupProgressReporter {
  private readonly _rows: FolderRow[];
  private readonly _total: TotalRow;
  private readonly _is_tty: boolean;
  private _rendered = false;
  private _last_rendered_lines = 0;
  private _status_message = '';

  constructor(folders: { name: string; total_items: number }[]) {
    this._is_tty = !!process.stdout.isTTY;
    this._rows = folders.map((f) => ({
      name: f.name,
      total_items: f.total_items,
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
    }));
    this._total = { global_processed: 0, global_total: 0, rate: 0, eta_seconds: 0 };
    this.render();
  }

  /** Sets a status message line below the TOTAL row (e.g. interrupt notice). */
  set_status(message: string): void {
    this._status_message = message;
    this.render();
  }

  /** Sets a folder as the currently active (cyan) row. */
  mark_active(index: number): void {
    const row = this._rows[index];
    if (!row) return;
    row.status = 'active';
    this.render();
  }

  /** Updates the active folder's processing stats. */
  update_active(index: number, processed: number, rate: number, eta_seconds: number): void {
    const row = this._rows[index];
    if (!row) return;
    row.processed = processed;
    row.rate = rate;
    row.eta_seconds = eta_seconds;
    this.render();
  }

  /** Shows fetching/paging progress on the active folder row. */
  update_paging(index: number, items_fetched: number, rate: number, eta_seconds: number): void {
    const row = this._rows[index];
    if (!row) return;
    row.status = 'paging';
    row.paging_fetched = items_fetched;
    row.paging_rate = rate;
    row.eta_seconds = eta_seconds;
    this.render();
  }

  /** Marks a folder as done (green), synced (yellow), or empty (dim gray). */
  mark_done(index: number, stored: number, deduped: number, attachments: number): void {
    const row = this._rows[index];
    if (!row) return;
    row.stored = stored;
    row.deduped = deduped;
    row.attachments = attachments;

    const nothing_processed = row.processed === 0 && stored === 0 && deduped === 0;
    if (nothing_processed && row.total_items === 0) {
      row.status = 'empty';
    } else if (nothing_processed && row.total_items > 0) {
      row.status = 'synced';
    } else {
      row.status = 'done';
    }

    if (!this._is_tty) this.log_non_tty(row);
    this.render();
  }

  /** Marks all non-terminal folders (pending/active/paging) as interrupted. */
  mark_all_pending_interrupted(): void {
    for (const row of this._rows) {
      if (row.status === 'pending' || row.status === 'active' || row.status === 'paging') {
        row.status = 'interrupted';
        if (!this._is_tty) this.log_non_tty(row);
      }
    }
    this.render();
  }

  /** Marks a folder as errored (red). */
  mark_error(index: number, message: string): void {
    const row = this._rows[index];
    if (!row) return;
    row.status = 'error';
    row.error_message = message;
    if (!this._is_tty) this.log_non_tty(row);
    this.render();
  }

  /** Updates the TOTAL row at the bottom. */
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

  /** Final render -- corrects total to the actual processed count and positions cursor below. */
  finish(actual_total?: number): void {
    if (actual_total !== undefined) {
      this._total.global_processed = actual_total;
      this._total.global_total = actual_total;
    }
    this.render();
  }

  /** Fallback for non-TTY: logs a single line per completed folder. */
  private log_non_tty(row: FolderRow): void {
    if (row.status === 'empty') {
      console.log(`  [--] ${row.name} -- 0 items -- empty`);
    } else if (row.status === 'synced') {
      console.log(`  [==] ${row.name} -- ${row.total_items} items -- up to date`);
    } else if (row.status === 'done') {
      console.log(`  [ok] ${row.name} -- ${row.stored} stored, ${row.deduped} dedup`);
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
    if (this._status_message) lines.push(chalk.yellow(this._status_message));

    if (this._rendered) {
      process.stdout.write(`\x1b[${this._last_rendered_lines}A`);
    }

    for (const line of lines) {
      process.stdout.write(`\r  ${line}\x1b[K\n`);
    }

    this._last_rendered_lines = lines.length;
    this._rendered = true;
  }
}

/** Pads a folder name to a fixed column width. */
function pad_name(name: string, width = 28): string {
  return name.length > width ? name.slice(0, width - 1) + '~' : name.padEnd(width);
}

/** Formats one folder row based on its current status. */
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

    case 'paging':
      return chalk.cyan(
        `[>>] ${name} fetching ${row.paging_fetched}/${row.total_items}` +
          ` | ${row.paging_rate.toFixed(1)} items/s` +
          ` | ETA ${format_duration(row.eta_seconds)}`,
      );

    case 'done':
      return chalk.green(
        `[ok] ${name} ${row.processed} items` +
          ` -- ${row.stored} stored, ${row.deduped} dedup` +
          (row.attachments > 0 ? `, ${row.attachments} att` : ''),
      );

    case 'synced':
      return chalk.yellow(`[==] ${name} ${row.total_items} items -- up to date`);

    case 'interrupted':
      return chalk.yellow(`[~~] ${name} -- interrupted`);

    case 'empty':
      return chalk.gray(`[--] ${name} 0 items -- empty`);

    case 'error':
      return chalk.red(`[!!] ${name} ERROR: ${row.error_message}`);
  }
}

/** Formats the TOTAL summary row at the bottom. */
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
