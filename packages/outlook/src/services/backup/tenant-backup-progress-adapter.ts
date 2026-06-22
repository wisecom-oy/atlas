import type { BackupProgressReporter } from '@atlas/types';
import type { TenantProgressReporter } from '@atlas/types';

interface FolderProgressInfo {
  readonly name: string;
  readonly total_items: number;
}

/** Creates a mailbox-scoped progress reporter that forwards updates to tenant progress slots. */
export function create_mailbox_progress_adapter(
  slot: number,
  tenant_progress: TenantProgressReporter | undefined,
): (folders: FolderProgressInfo[]) => BackupProgressReporter {
  return (folders: FolderProgressInfo[]): BackupProgressReporter => {
    const total_items = folders.reduce((sum, folder) => sum + folder.total_items, 0);

    return {
      set_status: (_message: string): void => {},
      mark_active: (index: number): void => {
        const folder = folders[index];
        if (folder) {
          tenant_progress?.update_mailbox_progress(slot, folder.name, 0, 0);
        }
      },
      update_active: (
        _index: number,
        processed: number,
        rate: number,
        _eta_seconds: number,
      ): void => {
        const pct = total_items > 0 ? Math.round((processed / total_items) * 100) : 0;
        tenant_progress?.update_mailbox_progress(slot, '', pct, rate);
      },
      update_paging: (
        _index: number,
        _items_fetched: number,
        rate: number,
        _eta_seconds: number,
      ): void => {
        tenant_progress?.update_mailbox_progress(slot, 'fetching...', 0, rate);
      },
      mark_done: (
        _index: number,
        _stored: number,
        _deduped: number,
        _attachments: number,
      ): void => {},
      mark_all_pending_interrupted: (): void => {},
      mark_error: (_index: number, _message: string): void => {},
      update_total: (
        _global_processed: number,
        _global_total: number,
        _rate: number,
        _eta_seconds: number,
      ): void => {},
      finish: (_actual_total?: number): void => {},
    };
  };
}
