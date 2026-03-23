export interface TenantProgressReporter {
  set_mailbox_count(total: number): void;
  mark_mailbox_active(slot: number, mailbox_id: string): void;
  update_mailbox_progress(slot: number, folder_name: string, pct: number, rate: number): void;
  mark_mailbox_done(slot: number, mailbox_id: string, stored: number, deduped: number): void;
  mark_mailbox_error(slot: number, mailbox_id: string, message: string): void;
  update_totals(
    done: number,
    errors: number,
    pending: number,
    rate: number,
    eta_seconds: number,
  ): void;
  set_status(message: string): void;
  finish(): void;
}
