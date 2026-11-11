import { is_active_run_cancelled } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { emit_operation_progress } from '@wisecom/atlas-core/services/shared/operation-progress';
import { append_all } from '@wisecom/atlas-core/utils/append-all';
import type { ContactManifestEntry, OperationControlOptions } from '@wisecom/atlas-types';

import {
  type EntryOutcome,
  restore_entry,
  type RestoreWriteDeps,
} from '@/services/restore/restore-contact-writer';
import {
  index_target_contacts,
  type TargetFolderContacts,
} from '@/services/restore/target-folder-contacts';
import { error_message } from '@/services/shared/error-message';
import { is_run_fatal } from '@/services/shared/run-fatal-error';

function describe_entry(entry: ContactManifestEntry): string {
  return entry.display_name ? `${entry.display_name} (${entry.contact_id})` : entry.contact_id;
}

/** The photo a restored contact left out, as one line; none for a skipped or complete contact. */
function photo_error_lines(entry: ContactManifestEntry, outcome: EntryOutcome): string[] {
  if (outcome.status !== 'restored' || outcome.photo_error === undefined) return [];
  return [
    `Contact ${describe_entry(entry)} restored without its photo: ${error_message(outcome.photo_error)}`,
  ];
}

export interface RestoreLoopOutcome {
  readonly processed: number;
  readonly restored: number;
  readonly skipped: number;
  readonly errors: string[];
  readonly interrupted: boolean;
}

/** Run-wide lookups shared by every entry. */
interface RestoreScope {
  readonly target_by_source: ReadonlyMap<string, string>;
  /** Every contact id in the snapshot. */
  readonly snapshot_ids: ReadonlySet<string>;
  /** What each target folder holds, loaded once per folder. */
  readonly cache: Map<string, TargetFolderContacts>;
}

/** Loads what a target folder already holds once, reused for every entry that targets it. */
async function existing_contacts_for(
  deps: RestoreWriteDeps,
  folder_id: string,
  scope: RestoreScope,
): Promise<TargetFolderContacts> {
  const cached = scope.cache.get(folder_id);
  if (cached !== undefined) return cached;
  const contacts = await deps.connector.list_folder_contacts(
    deps.tenant_id,
    deps.target_mailbox_id,
    folder_id,
  );
  const existing = index_target_contacts(contacts, scope.snapshot_ids);
  scope.cache.set(folder_id, existing);
  return existing;
}

/**
 * Restores one entry into the target folder its source folder was mapped to, and records a
 * created contact's source id so a later entry with the same id in this run is skipped.
 */
async function restore_mapped_entry(
  deps: RestoreWriteDeps,
  entry: ContactManifestEntry,
  scope: RestoreScope,
): Promise<EntryOutcome> {
  const folder_id = scope.target_by_source.get(entry.folder_id);
  if (folder_id === undefined) throw new Error('source folder was not mapped to a target folder');
  const existing = await existing_contacts_for(deps, folder_id, scope);
  const outcome = await restore_entry(deps, entry, folder_id, existing);
  if (outcome.status === 'restored') existing.source_ids.add(entry.contact_id);
  return outcome;
}

/**
 * Restores every manifest entry in order. A failed entry is recorded and the run continues;
 * auth and licence failures end the run. Interruption is checked before each entry.
 */
export async function restore_all_entries(
  deps: RestoreWriteDeps,
  entries: readonly ContactManifestEntry[],
  target_by_source: ReadonlyMap<string, string>,
  control: OperationControlOptions,
): Promise<RestoreLoopOutcome> {
  const scope: RestoreScope = {
    target_by_source,
    snapshot_ids: new Set(entries.map((entry) => entry.contact_id)),
    cache: new Map(),
  };
  const errors: string[] = [];
  let processed = 0;
  let restored = 0;
  let skipped = 0;
  let interrupted = false;

  for (const entry of entries) {
    if (control.should_interrupt?.() === true || control.abort_signal?.aborted === true) {
      interrupted = true;
      break;
    }
    processed += 1;
    try {
      const outcome = await restore_mapped_entry(deps, entry, scope);
      if (outcome.status === 'skipped') skipped += 1;
      else restored += 1;
      append_all(errors, photo_error_lines(entry, outcome));
    } catch (err) {
      if (is_run_fatal(err)) throw err;
      // A write cut short by cancellation is the run stopping. A write that landed anyway is
      // found by its source tag on the next restore (issue #673).
      if (is_active_run_cancelled()) {
        interrupted = true;
        break;
      }
      errors.push(`Contact ${describe_entry(entry)} failed to restore: ${error_message(err)}`);
    }
    emit_operation_progress(control, {
      operation: 'restore',
      workload: 'contacts',
      phase: 'processing',
      processed,
      total: entries.length,
    });
  }

  return { processed, restored, skipped, errors, interrupted };
}
