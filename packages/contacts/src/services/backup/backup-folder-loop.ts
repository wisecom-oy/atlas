import type {
  BackupProgressReporter,
  ContactManifestEntry,
  GraphContactFolder,
  OperationControlOptions,
} from '@wisecom/atlas-types';
import { emit_operation_progress } from '@wisecom/atlas-core/services/shared/operation-progress';
import { type FolderSyncDeps, sync_folder } from '@/services/backup/backup-folder-sync';
import { is_run_fatal } from '@/services/shared/run-fatal-error';
import { error_message } from '@/services/shared/error-message';
import { append_all } from '@wisecom/atlas-core/utils/append-all';

/** Final entries and delta links for every listed folder, plus run-level counts. */
export interface FolderLoopOutcome {
  readonly entries: readonly ContactManifestEntry[];
  readonly delta_link_by_folder: Record<string, string>;
  readonly objects_stored: number;
  readonly errors: string[];
  readonly interrupted: boolean;
}

/**
 * One folder's state after the loop. `fresh` is false when the folder was not synced this run and
 * carries the previous snapshot's entries instead.
 */
interface FolderState {
  readonly entries: readonly ContactManifestEntry[];
  readonly delta_link?: string | undefined;
  readonly fresh: boolean;
}

/** Inputs describing the previous, consistent state of the mailbox. */
export interface FolderLoopState {
  readonly previous_entries: readonly ContactManifestEntry[];
  readonly read_links: Readonly<Record<string, string>>;
  readonly kept_links: Readonly<Record<string, string>>;
}

function previous_state_for(folder: GraphContactFolder, state: FolderLoopState): FolderState {
  const entries = state.previous_entries.filter((entry) => entry.folder_id === folder.id);
  return { entries, delta_link: state.kept_links[folder.id], fresh: false };
}

/** Marks a synced folder's progress row done, or errored when some of its contacts failed. */
function report_folder_row(
  reporter: BackupProgressReporter,
  index: number,
  stored: number,
  failed: number,
): void {
  if (failed === 0) reporter.mark_done(index, stored, 0, 0);
  else reporter.mark_error(index, `${failed} contact(s) failed`);
}

/**
 * Syncs every listed folder in order. Folders that are interrupted or fail keep their previous
 * entries and delta link, so the next run retries them from a consistent point. Auth and
 * licence failures end the run, since no other folder can succeed either.
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
        states.push({ entries: result.entries, delta_link: result.delta_link, fresh: true });
        append_all(errors, result.errors);
        report_folder_row(reporter, index, result.objects_stored, result.errors.length);
      } else {
        interrupted = true;
        states.push(previous);
      }
    } catch (err) {
      if (is_run_fatal(err)) throw err;
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
    entries: merge_folder_entries(states),
    delta_link_by_folder: collect_links(folders, states),
    objects_stored,
    errors,
    interrupted,
  };
}

/**
 * Flattens folder states. A contact moved out of a folder that failed this run into one that
 * synced would otherwise appear twice; the synced folder's view wins because it is current.
 */
function merge_folder_entries(states: readonly FolderState[]): ContactManifestEntry[] {
  const fresh_ids = new Set(
    states.filter((s) => s.fresh).flatMap((s) => s.entries.map((entry) => entry.contact_id)),
  );
  return states.flatMap((s) =>
    s.fresh ? [...s.entries] : s.entries.filter((entry) => !fresh_ids.has(entry.contact_id)),
  );
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
