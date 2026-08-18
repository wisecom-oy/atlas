import type { TransferProgressReporter } from '@wisecom/atlas-types';
import { TransferProgressStore } from '@/ui/dashboards/transfer-progress-store';
import { TransferProgressView } from '@/ui/dashboards/transfer-progress';
import type { TransferVerb } from '@/ui/dashboards/transfer-progress';
import { TransferProgressLineReporter } from '@/ui/dashboards/transfer-progress-line-reporter';
import { mount_live_view } from '@/ui/render';

/** Ink store whose `finish()` also unmounts the live view it belongs to. */
class MountedTransferProgressStore extends TransferProgressStore {
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
 * Builds the `create_progress` hook for SaveOptions/RestoreOptions: an Ink
 * dashboard on interactive terminals, plain parity log lines otherwise. The
 * live view unmounts itself when the service calls `finish()`.
 */
export function create_transfer_progress(
  verb: TransferVerb,
): (folders: { name: string; total_items: number }[]) => TransferProgressReporter {
  return (folders) => {
    if (!process.stdout.isTTY) {
      return new TransferProgressLineReporter(folders, verb);
    }
    const store = new MountedTransferProgressStore(folders);
    const instance = mount_live_view(<TransferProgressView store={store} verb={verb} />);
    store.attach_unmount(() => instance.unmount());
    return store;
  };
}
