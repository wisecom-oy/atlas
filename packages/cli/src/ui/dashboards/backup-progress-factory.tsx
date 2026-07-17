import type { BackupProgressReporter } from '@wisecom/atlas-types';
import { BackupProgressStore } from '@/ui/dashboards/backup-progress-store';
import type { BackupUnits } from '@/ui/dashboards/backup-progress';
import { BackupProgressView } from '@/ui/dashboards/backup-progress';
import { BackupProgressLineReporter } from '@/ui/dashboards/backup-progress-line-reporter';
import { mount_live_view } from '@/ui/render';

/** Ink store whose `finish()` also unmounts the live view it belongs to. */
class MountedBackupProgressStore extends BackupProgressStore {
  private _unmount: (() => void) | undefined;

  attach_unmount(unmount: () => void): void {
    this._unmount = unmount;
  }

  override finish(actual_total?: number): void {
    super.finish(actual_total);
    this._unmount?.();
    this._unmount = undefined;
  }
}

/**
 * Builds the `create_progress` hook for per-row backup dashboards (OneDrive
 * drives, and any future row-based backup): an Ink dashboard on interactive
 * terminals, plain parity log lines otherwise. The live view unmounts itself
 * when the service calls `finish()`.
 */
export function create_backup_progress(
  units?: BackupUnits,
): (rows: { name: string; total_items: number }[]) => BackupProgressReporter {
  return (rows) => {
    if (!process.stdout.isTTY) {
      return new BackupProgressLineReporter(rows);
    }
    const store = new MountedBackupProgressStore(rows);
    const instance = mount_live_view(
      <BackupProgressView store={store} {...(units && { units })} />,
    );
    store.attach_unmount(() => instance.unmount());
    return store;
  };
}
