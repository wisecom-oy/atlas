/**
 * Compact, fixed-height tenant-level backup dashboard.
 * Shows one row per concurrent worker, overall progress header, and summary footer.
 * Height is fixed at (concurrency + 5) lines regardless of tenant size.
 */

import chalk from 'chalk';
import { format_duration } from '@atlas/core/services/shared/progress-rate';
import type { TenantProgressReporter } from '@atlas/types';

interface MailboxSlot {
  owner_id: string;
  folder_name: string;
  pct: number;
  rate: number;
  status: 'active' | 'done' | 'error';
  stored: number;
  deduped: number;
  error_message: string;
}

interface Totals {
  mailbox_count: number;
  done: number;
  errors: number;
  pending: number;
  rate: number;
  eta_seconds: number;
}

/** ~24 fps cap: 1000ms / 24 frames ≈ 42ms per frame. */
const FRAME_INTERVAL_MS = 42;

export class TenantBackupDashboard implements TenantProgressReporter {
  private readonly _max_slots: number;
  private readonly _slots: (MailboxSlot | undefined)[];
  private readonly _totals: Totals;
  private readonly _is_tty: boolean;
  private _rendered = false;
  private _status_message = '';
  private _last_render_ms = 0;
  private _render_timer: ReturnType<typeof setTimeout> | undefined;
  private _dirty = false;

  constructor(max_slots = 3) {
    this._max_slots = max_slots;
    this._slots = new Array<MailboxSlot | undefined>(max_slots).fill(undefined);
    this._totals = { mailbox_count: 0, done: 0, errors: 0, pending: 0, rate: 0, eta_seconds: 0 };
    this._is_tty = !!process.stdout.isTTY;
  }

  set_mailbox_count(total: number): void {
    this._totals.mailbox_count = total;
    this._totals.pending = total;
    this.scheduleRender();
  }

  mark_mailbox_active(slot: number, owner_id: string): void {
    if (slot < 0 || slot >= this._max_slots) return;
    this._slots[slot] = {
      owner_id,
      folder_name: '',
      pct: 0,
      rate: 0,
      status: 'active',
      stored: 0,
      deduped: 0,
      error_message: '',
    };
    this.scheduleRender();
  }

  update_mailbox_progress(slot: number, folder_name: string, pct: number, rate: number): void {
    const s = this._slots[slot];
    if (!s) return;
    if (folder_name) s.folder_name = folder_name;
    s.pct = pct;
    s.rate = rate;
    this.scheduleRender();
  }

  mark_mailbox_done(slot: number, owner_id: string, stored: number, deduped: number): void {
    if (!this._is_tty) {
      console.log(`  [ok] ${owner_id} -- ${stored} stored, ${deduped} dedup`);
    }
    const s = this._slots[slot];
    if (s) {
      s.status = 'done';
      s.stored = stored;
      s.deduped = deduped;
    }
    this._slots[slot] = undefined;
    this.scheduleRender();
  }

  mark_mailbox_error(slot: number, owner_id: string, message: string): void {
    if (!this._is_tty) {
      console.log(`  [!!] ${owner_id} -- ERROR: ${message}`);
    }
    const s = this._slots[slot];
    if (s) {
      s.status = 'error';
      s.error_message = message;
    }
    this._slots[slot] = undefined;
    this.scheduleRender();
  }

  update_totals(
    done: number,
    errors: number,
    pending: number,
    rate: number,
    eta_seconds: number,
  ): void {
    this._totals.done = done;
    this._totals.errors = errors;
    this._totals.pending = pending;
    this._totals.rate = rate;
    this._totals.eta_seconds = eta_seconds;
    this.scheduleRender();
  }

  set_status(message: string): void {
    this._status_message = message;
    this.scheduleRender();
  }

  finish(): void {
    if (this._render_timer) {
      clearTimeout(this._render_timer);
      this._render_timer = undefined;
    }
    this.flushFrame();
  }

  /** Fixed line count: header + separator + slots + separator + summary + status = max_slots + 5. */
  private get fixedHeight(): number {
    return this._max_slots + 5;
  }

  /** Throttles render calls to ~24 fps. Renders immediately if enough time has passed. */
  private scheduleRender(): void {
    this._dirty = true;
    const now = Date.now();
    const elapsed = now - this._last_render_ms;

    if (elapsed >= FRAME_INTERVAL_MS) {
      if (this._render_timer) {
        clearTimeout(this._render_timer);
        this._render_timer = undefined;
      }
      this.flushFrame();
      return;
    }

    if (!this._render_timer) {
      this._render_timer = setTimeout(() => {
        this._render_timer = undefined;
        if (this._dirty) this.flushFrame();
      }, FRAME_INTERVAL_MS - elapsed);
    }
  }

  private flushFrame(): void {
    if (!this._is_tty) return;
    this._dirty = false;
    this._last_render_ms = Date.now();

    const lines: string[] = [];
    const t = this._totals;
    const completed = t.done + t.errors;
    const eta_str = t.eta_seconds > 0 ? format_duration(t.eta_seconds) : '--';

    lines.push(
      chalk.bold.white(
        `Atlas Tenant Backup -- ${completed}/${t.mailbox_count} mailboxes` +
          ` | ${t.rate.toFixed(1)} msg/s | ETA ${eta_str}`,
      ),
    );
    lines.push(chalk.gray('-'.repeat(63)));

    for (let i = 0; i < this._max_slots; i++) {
      const s = this._slots[i];
      if (!s) {
        lines.push(chalk.gray('[  ] --'));
      } else {
        const owner_label = truncate(s.owner_id, 30);
        const folder = s.folder_name ? truncate(s.folder_name, 14) : '';
        const pct_str = s.pct > 0 ? ` ${s.pct}%` : '';
        lines.push(
          chalk.cyan(
            `[>>] ${pad(owner_label, 32)}${pad(folder + pct_str, 18)}| ${s.rate.toFixed(1)} msg/s`,
          ),
        );
      }
    }

    lines.push(chalk.gray('-'.repeat(63)));

    const done_str = chalk.green(`[ok] ${t.done} done`);
    const err_str = t.errors > 0 ? chalk.red(`  [!!] ${t.errors} error`) : '';
    const pending_str = chalk.gray(`  [  ] ${t.pending} pending`);
    lines.push(`${done_str}${err_str}${pending_str}`);

    const status = this._status_message ? chalk.yellow(this._status_message) : '';
    lines.push(status);

    let frame = '\x1b[?25l';
    if (this._rendered) {
      frame += `\x1b[${this.fixedHeight}A`;
    }
    for (const line of lines) {
      frame += `\r  ${line}\x1b[K\n`;
    }
    frame += '\x1b[?25h';
    process.stdout.write(frame);

    this._rendered = true;
  }
}

function pad(str: string, width: number): string {
  return str.padEnd(width);
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '~' : str;
}
