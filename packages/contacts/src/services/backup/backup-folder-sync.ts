import type {
  ContactFolderDelta,
  ContactManifestEntry,
  ContactsConnector,
  GraphContactFolder,
  GraphContactPayload,
  TenantContext,
} from '@wisecom/atlas-types';
import { is_run_fatal } from '@/services/shared/run-fatal-error';
import { is_graph_outage } from '@wisecom/atlas-core/services/shared/graph-outage-latch';
import { store_contact_entry } from '@/services/backup/backup-contact-store';
import { capture_contact_photo, is_photo_pending } from '@/services/backup/contact-photo-capture';
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
 * Stores one contact into the merge. A failure of the contact's own is recorded and the contact
 * falls back to its previous entry. A run-fatal failure is thrown, and so is a Graph outage, which
 * fails the folder so it keeps its previous state rather than one failure per remaining contact.
 */
async function apply_contact(
  deps: FolderSyncDeps,
  folder: GraphContactFolder,
  contact: GraphContactPayload,
  ids_with_attachments: ReadonlySet<string>,
  merge: FolderMerge,
): Promise<void> {
  const previous = merge.previous_by_id.get(contact.id);
  try {
    const stored = await store_contact_entry(
      deps,
      folder.id,
      contact,
      ids_with_attachments,
      previous,
    );
    merge.objects_stored += stored.objects_stored;
    merge.by_id.set(contact.id, stored.entry);
  } catch (err) {
    if (is_run_fatal(err) || is_graph_outage(err)) throw err;
    merge.errors.push(
      `Contact ${describe_contact(contact)} in ${folder.display_name} failed: ${error_message(err)}`,
    );
    if (previous === undefined) merge.by_id.delete(contact.id);
    else merge.by_id.set(contact.id, previous);
  }
}

/**
 * Requests again the photo of a contact delta did not list this run, whose last photo request
 * answered "not found" without confirming it absent (issue #854). The entry keeps its state when
 * the request fails, and the failure is recorded like a contact's own.
 */
async function recheck_pending_photo(
  deps: FolderSyncDeps,
  folder: GraphContactFolder,
  entry: ContactManifestEntry,
  merge: FolderMerge,
): Promise<void> {
  try {
    const captured = await capture_contact_photo(deps, entry, entry);
    merge.objects_stored += captured.objects_stored;
    merge.by_id.set(entry.contact_id, captured.entry);
  } catch (err) {
    if (is_run_fatal(err) || is_graph_outage(err)) throw err;
    merge.errors.push(
      `Photo of contact ${entry.contact_id} in ${folder.display_name} failed: ${error_message(err)}`,
    );
  }
}

/** Entries the delta left untouched whose photo is still owed a request. */
function entries_owing_photo(
  merge: FolderMerge,
  delta: ContactFolderDelta,
): ContactManifestEntry[] {
  const listed = new Set(delta.upserted.map((contact) => contact.id));
  return [...merge.by_id.values()].filter(
    (entry) => !listed.has(entry.contact_id) && is_photo_pending(entry),
  );
}

/** One unit of a folder's contact work: storing a listed contact or re-requesting a photo. */
type ContactTask = () => Promise<void>;

/**
 * Runs the folder's contact work at most `CONTACT_CONCURRENCY` at a time. Returns `true` when the
 * run was interrupted before every task started. A task's throw stops the rest and is rethrown.
 */
async function run_contact_tasks(
  deps: FolderSyncDeps,
  tasks: readonly ContactTask[],
): Promise<boolean> {
  let interrupted = false;
  let fatal: Error | undefined;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length && fatal === undefined && !interrupted) {
      if (deps.should_interrupt()) {
        interrupted = true;
        return;
      }
      const task = tasks[next++];
      if (task === undefined) return;
      try {
        await task();
      } catch (err) {
        fatal = err instanceof Error ? err : new Error(String(err));
      }
    }
  };
  const workers = Math.min(CONTACT_CONCURRENCY, tasks.length);
  await Promise.all(Array.from({ length: workers }, worker));
  if (fatal !== undefined) throw fatal;
  return interrupted;
}

/**
 * Lists which of a folder's contacts carry an attachment, so only those get a photo request.
 * A delta with no upserts stores no contact, so the listing is skipped.
 */
async function read_ids_with_attachments(
  deps: FolderSyncDeps,
  folder: GraphContactFolder,
  delta: ContactFolderDelta,
): Promise<ReadonlySet<string>> {
  if (delta.upserted.length === 0) return new Set();
  return deps.connector.list_contact_ids_with_attachments(
    deps.tenant_id,
    deps.mailbox_id,
    folder.id,
  );
}

/**
 * Applies one folder's delta over `base` (the previous snapshot's entries for that folder).
 * A full read (no link, or a reset) replaces the base with the folder's current contents.
 *
 * A contact that fails to store keeps its previous entry and is reported; the rest of the folder
 * still lands. The folder then keeps its old delta link so the next run delivers the failed
 * contact again, and a reset folder keeps no link because its old one was rejected. A contact
 * whose photo is still owed a request after a "not found" answer is asked again even when delta
 * does not list it, so that answer never holds the link back.
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
  const ids_with_attachments = await read_ids_with_attachments(deps, folder, delta);
  const full_read = delta_link === undefined || delta.reset;
  const previous_by_id = new Map(base.map((entry) => [entry.contact_id, entry]));
  const merge: FolderMerge = {
    by_id: new Map(full_read ? [] : previous_by_id),
    previous_by_id,
    errors: [],
    objects_stored: 0,
  };
  for (const removed_id of delta.removed_ids) merge.by_id.delete(removed_id);

  const tasks: ContactTask[] = [
    ...delta.upserted.map(
      (contact) => (): Promise<void> =>
        apply_contact(deps, folder, contact, ids_with_attachments, merge),
    ),
    ...entries_owing_photo(merge, delta).map(
      (entry) => (): Promise<void> => recheck_pending_photo(deps, folder, entry, merge),
    ),
  ];
  if (await run_contact_tasks(deps, tasks)) {
    return { complete: false, objects_stored: merge.objects_stored };
  }

  const retry_link = delta.reset ? undefined : delta_link;
  return {
    complete: true,
    entries: [...merge.by_id.values()],
    delta_link: merge.errors.length === 0 ? delta.delta_link : retry_link,
    objects_stored: merge.objects_stored,
    errors: merge.errors,
  };
}
