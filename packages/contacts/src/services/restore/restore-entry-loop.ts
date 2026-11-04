import { emit_operation_progress } from '@wisecom/atlas-core/services/shared/operation-progress';
import type { ContactManifestEntry, OperationControlOptions } from '@wisecom/atlas-types';

import { collision_key } from '@/services/restore/collision-key';
import { restore_entry, type RestoreWriteDeps } from '@/services/restore/restore-contact-writer';
import { error_message } from '@/services/shared/error-message';

export interface RestoreLoopOutcome {
  readonly processed: number;
  readonly restored: number;
  readonly skipped: number;
  readonly errors: string[];
  readonly interrupted: boolean;
}

/** Loads the collision keys of a target folder once, reused for every entry that targets it. */
async function existing_keys_for(
  deps: RestoreWriteDeps,
  folder_id: string,
  cache: Map<string, Set<string>>,
): Promise<Set<string>> {
  const cached = cache.get(folder_id);
  if (cached !== undefined) return cached;
  const contacts = await deps.connector.list_folder_contacts(
    deps.tenant_id,
    deps.target_mailbox_id,
    folder_id,
  );
  const keys = new Set<string>();
  for (const contact of contacts) {
    const key = collision_key(contact);
    if (key !== undefined) keys.add(key);
  }
  cache.set(folder_id, keys);
  return keys;
}

/**
 * Restores every manifest entry in order. A failed entry is recorded and the run continues;
 * interruption is checked before each entry.
 */
export async function restore_all_entries(
  deps: RestoreWriteDeps,
  entries: readonly ContactManifestEntry[],
  target_by_source: ReadonlyMap<string, string>,
  control: OperationControlOptions,
): Promise<RestoreLoopOutcome> {
  const keys_by_folder = new Map<string, Set<string>>();
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
      const folder_id = target_by_source.get(entry.folder_id);
      if (folder_id === undefined) {
        throw new Error('source folder was not mapped to a target folder');
      }
      const keys = await existing_keys_for(deps, folder_id, keys_by_folder);
      const outcome = await restore_entry(deps, entry, folder_id, keys);
      if (outcome === 'restored') restored += 1;
      else skipped += 1;
    } catch (err) {
      errors.push(`Contact restore failed: ${error_message(err)}`);
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
