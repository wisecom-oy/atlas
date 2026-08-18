import type { TenantProgressReporter } from '@wisecom/atlas-types';

/**
 * Non-TTY fallback for the tenant backup dashboard: one plain log line per
 * completed or failed mailbox, byte-identical to the pre-Ink output.
 */
export class TenantBackupLineReporter implements TenantProgressReporter {
  set_mailbox_count(_total: number): void {}

  mark_mailbox_active(_slot: number, _owner_id: string): void {}

  update_mailbox_progress(_slot: number, _folder_name: string, _pct: number, _rate: number): void {}

  mark_mailbox_done(_slot: number, owner_id: string, stored: number, deduped: number): void {
    console.log(`  [ok] ${owner_id} -- ${stored} stored, ${deduped} dedup`);
  }

  mark_mailbox_error(_slot: number, owner_id: string, message: string): void {
    console.log(`  [!!] ${owner_id} -- ERROR: ${message}`);
  }

  update_totals(
    _done: number,
    _errors: number,
    _pending: number,
    _rate: number,
    _eta_seconds: number,
  ): void {}

  set_status(_message: string): void {}

  finish(): void {}
}
