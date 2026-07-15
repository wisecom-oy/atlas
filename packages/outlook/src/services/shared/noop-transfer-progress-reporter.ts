import type { TransferProgressReporter, TransferProgressUpdate } from '@wisecom/atlas-types';

/** Default reporter when no presenter is injected (e.g. SDK callers). */
export class NoopTransferProgressReporter implements TransferProgressReporter {
  mark_active(_index: number): void {}
  update_active(_index: number, _update: TransferProgressUpdate): void {}
  mark_done(_index: number, _transferred: number, _attachments: number): void {}
  mark_all_pending_interrupted(): void {}
  mark_error(_index: number, _message: string): void {}
  update_total(
    _global_processed: number,
    _global_total: number,
    _rate: number,
    _eta_seconds: number,
  ): void {}
  show_finalizing(): void {}
  finish(_actual_total?: number): void {}
}
