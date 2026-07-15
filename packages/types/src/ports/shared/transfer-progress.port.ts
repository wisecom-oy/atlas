/**
 * Progress reporting contract for folder-by-folder transfer operations
 * (save-to-zip, restore-to-mailbox). Implemented by CLI presenters (Ink
 * dashboard or plain line logger); services stay presentation-free.
 */

export interface TransferProgressUpdate {
  /** Items transferred so far (saved or restored). */
  readonly transferred: number;
  readonly attachments: number;
  readonly integrity_ok?: number;
  readonly integrity_fail?: number;
  readonly rate: number;
  readonly eta_seconds: number;
}

export interface TransferProgressReporter {
  mark_active(index: number): void;
  update_active(index: number, update: TransferProgressUpdate): void;
  mark_done(index: number, transferred: number, attachments: number): void;
  mark_all_pending_interrupted(): void;
  mark_error(index: number, message: string): void;
  update_total(
    global_processed: number,
    global_total: number,
    rate: number,
    eta_seconds: number,
  ): void;
  /** Switches the TOTAL row to a "finalizing" state while an archive is closed. */
  show_finalizing(): void;
  finish(actual_total?: number): void;
}
