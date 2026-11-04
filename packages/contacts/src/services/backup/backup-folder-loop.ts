import type {
  BackupProgressReporter,
  ContactManifestEntry,
  GraphContactFolder,
  OperationControlOptions,
} from '@wisecom/atlas-types';
import { emit_operation_progress } from '@wisecom/atlas-core/services/shared/operation-progress';
import { type FolderSyncDeps, sync_folder } from '@/services/backup/backup-folder-sync';
import { error_message } from '@/services/shared/error-message';

/** Final entries and delta links for every listed folder, plus run-level counts. */
export interface FolderLoopOutcome {
  readonly entries: readonly ContactManifestEntry[];
  readonly delta_link_by_folder: Record<string, string>;
  readonly objects_stored: number;
  readonly errors: string[];
  readonly interrupted: boolean;
}

/** One folder's state after the loop: fresh from a sync, or the previous state when it was not synced. */
interface FolderState {
  readonly entries: readonly ContactManifestEntry[];
  readonly delta_link?: string;
}

/** Inputs describing the previous, consistent state of the mailbox. */
export interface FolderLoopState {
  readonly previous_entries: readonly ContactManifestEntry[];
  readonly read_links: Readonly<Record<string, string>>;
  readonly kept_links: Readonly<Record<string, string>>;
}

function previous_state_for(folder: GraphContactFolder, state: FolderLoopState): FolderState {
  const entries = state.previous_entries.filter((entry) => entry.folder_id === folder.id);
  const delta_link = state.kept_links[folder.id];
  return delta_link === undefined ? { entries } : { entries, delta_link };
}

/**
 * Syncs every listed folder in order. Folders that are interrupted or fail keep their previous
 * entries and delta link, so the next run retries them from a consistent point.
 */
export async function sync_all_folders(
  deps: FolderSyncDeps,
  folders: readonly GraphContactFolder[],
  state: FolderLoopState,
  control: OperationControlOptions,
  reporter: BackupProgressReporter,
): Promise<FolderLoopOutcome> {
  const states: FolderState[] = [];
  const errors: string[] = [];
  let objects_stored = 0;
  let interrupted = false;
  for (const [index, folder] of folders.entries()) {
    const previous = previous_state_for(folder, state);
    if (interrupted || deps.should_interrupt()) {
      interrupted = true;
      states.push(previous);
      continue;
    }
    reporter.mark_active(index);
    try {
      const result = await sync_folder(deps, folder, previous.entries, state.read_links[folder.id]);
      objects_stored += result.objects_stored;
      if (result.complete) {
        states.push({ entries: result.entries, delta_link: result.delta_link });
        reporter.mark_done(index, result.objects_stored, 0, 0);
      } else {
        interrupted = true;
        states.push(previous);
      }
    } catch (err) {
      const message = error_message(err);
      errors.push(`Contacts folder ${folder.display_name} failed: ${message}`);
      states.push(previous);
      reporter.mark_error(index, message);
    }
    emit_operation_progress(control, {
      operation: 'backup',
      workload: 'contacts',
      phase: 'processing',
      processed: index + 1,
      total: folders.length,
    });
  }
  if (interrupted) reporter.mark_all_pending_interrupted();
  return {
    entries: states.flatMap((folder_state) => [...folder_state.entries]),
    delta_link_by_folder: collect_links(folders, states),
    objects_stored,
    errors,
    interrupted,
  };
}

function collect_links(
  folders: readonly GraphContactFolder[],
  states: readonly FolderState[],
): Record<string, string> {
  const links: Record<string, string> = {};
  for (const [index, folder] of folders.entries()) {
    const link = states[index]?.delta_link;
    if (link !== undefined) links[folder.id] = link;
  }
  return links;
}
