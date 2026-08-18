import type { TenantProgressReporter } from '@wisecom/atlas-types';
import { DashboardStore } from '@/ui/dashboards/dashboard-store';

export interface MailboxSlot {
  owner_id: string;
  folder_name: string;
  pct: number;
  rate: number;
}

export interface TenantBackupState {
  slots: (MailboxSlot | undefined)[];
  mailbox_count: number;
  done: number;
  errors: number;
  pending: number;
  rate: number;
  eta_seconds: number;
  status_message: string;
}

/** Translates TenantProgressReporter calls into Ink-consumable state snapshots. */
export class TenantBackupStore
  extends DashboardStore<TenantBackupState>
  implements TenantProgressReporter
{
  private readonly _max_slots: number;

  constructor(max_slots = 3) {
    super({
      slots: new Array<MailboxSlot | undefined>(max_slots).fill(undefined),
      mailbox_count: 0,
      done: 0,
      errors: 0,
      pending: 0,
      rate: 0,
      eta_seconds: 0,
      status_message: '',
    });
    this._max_slots = max_slots;
  }

  set_mailbox_count(total: number): void {
    this.update((draft) => {
      draft.mailbox_count = total;
      draft.pending = total;
    });
  }

  mark_mailbox_active(slot: number, owner_id: string): void {
    if (slot < 0 || slot >= this._max_slots) return;
    this.update((draft) => {
      draft.slots = draft.slots.with(slot, { owner_id, folder_name: '', pct: 0, rate: 0 });
    });
  }

  update_mailbox_progress(slot: number, folder_name: string, pct: number, rate: number): void {
    this.update((draft) => {
      const current = draft.slots[slot];
      if (!current) return;
      draft.slots = draft.slots.with(slot, {
        ...current,
        folder_name: folder_name || current.folder_name,
        pct,
        rate,
      });
    });
  }

  mark_mailbox_done(slot: number, _owner_id: string, _stored: number, _deduped: number): void {
    this.clear_slot(slot);
  }

  mark_mailbox_error(slot: number, _owner_id: string, _message: string): void {
    this.clear_slot(slot);
  }

  update_totals(
    done: number,
    errors: number,
    pending: number,
    rate: number,
    eta_seconds: number,
  ): void {
    this.update((draft) => {
      draft.done = done;
      draft.errors = errors;
      draft.pending = pending;
      draft.rate = rate;
      draft.eta_seconds = eta_seconds;
    });
  }

  set_status(message: string): void {
    this.update((draft) => {
      draft.status_message = message;
    });
  }

  finish(): void {}

  private clear_slot(slot: number): void {
    if (slot < 0 || slot >= this._max_slots) return;
    this.update((draft) => {
      draft.slots = draft.slots.with(slot, undefined);
    });
  }
}
