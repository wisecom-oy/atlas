import type {
  ContactManifestEntry,
  ContactsConnector,
  GraphContactFolder,
  GraphContactPayload,
  TenantContext,
} from '@wisecom/atlas-types';
import { is_run_fatal } from '@/services/shared/run-fatal-error';
import { store_contact_entry } from '@/services/backup/backup-contact-store';
import { error_message } from '@/services/shared/error-message';

/** Exchange allows four concurrent requests per mailbox; more only queue in the limiter. */
const CONTACT_CONCURRENCY = 4;

/** Shared inputs for syncing every folder of one mailbox in one run. */
export interface FolderSyncDeps {
  readonly ctx: TenantContext;
  readonly connector: ContactsConnector;
  readonly tenant_id: string;
  readonly mailbox_id: string;
  readonly should_interrupt: () => boolean;
}

/**
 * A folder synced to its final state, or one left partway when the run was interrupted.
 * `delta_link` is undefined when the folder must be re-read in full next run.
 */
export type FolderSyncResult =
  | {
      readonly complete: true;
      readonly entries: readonly ContactManifestEntry[];
      readonly delta_link: string | undefined;
      readonly objects_stored: number;
      readonly errors: readonly string[];
    }
  | { readonly complete: false; readonly objects_stored: number };

function describe_contact(contact: GraphContactPayload): string {
  const name = contact['displayName'];
  return typeof name === 'string' && name !== '' ? `${name} (${contact.id})` : contact.id;
}

/** Mutable merge state of one folder while its contacts are stored. */
interface FolderMerge {
  readonly by_id: Map<string, ContactManifestEntry>;
  readonly previous_by_id: ReadonlyMap<string, ContactManifestEntry>;
  readonly errors: string[];
  objects_stored: number;
}

/**
 * Stores one contact into the merge. A non-fatal failure is recorded and the contact falls back
 * to its previous entry; a run-fatal failure is thrown.
 */
async function apply_contact(
  deps: FolderSyncDeps,
  folder: GraphContactFolder,
  contact: GraphContactPayload,
  merge: FolderMerge,
): Promise<void> {
  try {
    const stored = await store_contact_entry(
      deps.ctx,
      deps.connector,
      deps.tenant_id,
      deps.mailbox_id,
      folder.id,
      contact,
    );
    merge.objects_stored += stored.objects_stored;
    merge.by_id.set(contact.id, stored.entry);
  } catch (err) {
    if (is_run_fatal(err)) throw err;
    merge.errors.push(
      `Contact ${describe_contact(contact)} in ${folder.display_name} failed: ${error_message(err)}`,
    );
    const prior = merge.previous_by_id.get(contact.id);
    if (prior === undefined) merge.by_id.delete(contact.id);
    else merge.by_id.set(contact.id, prior);
  }
}
/**
 * Applies one folder's delta over `base` (the previous snapshot's entries for that folder).
 * A full read (no link, or a reset) replaces the base with the folder's current contents.
 *
 * A contact that fails to store keeps its previous entry and is reported; the rest of the folder
 * still lands. The folder then keeps its old delta link so the next run delivers the failed
 * contact again, and a reset folder keeps no link because its old one was rejected.
 */
export async function sync_folder(
  deps: FolderSyncDeps,
  folder: GraphContactFolder,
  base: readonly ContactManifestEntry[],
  delta_link: string | undefined,
): Promise<FolderSyncResult> {
  const delta = await deps.connector.fetch_contact_delta(
    deps.tenant_id,
    deps.mailbox_id,
    folder.id,
    delta_link,
  );
  const full_read = delta_link === undefined || delta.reset;
  const previous_by_id = new Map(base.map((entry) => [entry.contact_id, entry]));
  const merge: FolderMerge = {
    by_id: new Map(full_read ? [] : previous_by_id),
    previous_by_id,
    errors: [],
    objects_stored: 0,
  };
  for (const removed_id of delta.removed_ids) merge.by_id.delete(removed_id);

  let interrupted = false;
  let fatal: Error | undefined;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < delta.upserted.length && fatal === undefined && !interrupted) {
      if (deps.should_interrupt()) {
        interrupted = true;
        return;
      }
      const contact = delta.upserted[next++];
      if (contact === undefined) return;
      try {
        await apply_contact(deps, folder, contact, merge);
      } catch (err) {
        fatal = err instanceof Error ? err : new Error(String(err));
      }
    }
  };
  const workers = Math.min(CONTACT_CONCURRENCY, delta.upserted.length);
  await Promise.all(Array.from({ length: workers }, worker));
  if (fatal !== undefined) throw fatal;
  if (interrupted) return { complete: false, objects_stored: merge.objects_stored };

  const retry_link = delta.reset ? undefined : delta_link;
  return {
    complete: true,
    entries: [...merge.by_id.values()],
    delta_link: merge.errors.length === 0 ? delta.delta_link : retry_link,
    objects_stored: merge.objects_stored,
    errors: merge.errors,
  };
}
