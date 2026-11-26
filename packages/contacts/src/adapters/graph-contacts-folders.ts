import type { Client } from '@microsoft/microsoft-graph-client';
import type { GraphContactFolder } from '@wisecom/atlas-types';
import { read_owner_listing } from '@wisecom/atlas-m365-graph';
import {
  CONTACTS_READ,
  CONTACTS_READ_WRITE,
  CREATE_ONCE,
  collect_listing,
  get_json,
  graph_call,
  mailbox_url,
  string_field,
} from '@/adapters/graph-contacts-requests';

interface FolderPayload {
  readonly id: string;
  readonly displayName: string;
}

/**
 * Lists the default Contacts folder first, then every descendant folder with its display-name path.
 * A 404 or other unclassified 4xx anywhere in the walk reads the whole listing again before it is
 * believed, since the listing decides whether the run happens (#864).
 *
 * @throws ListingIncompleteError when one folder's child listing holds fewer folders than Graph counted.
 * @throws NotFoundError when the listing and the mailbox's user both answered 404 on every read.
 * @throws GraphUnavailableError when a 404 or another 4xx persisted for a mailbox that exists.
 */
export async function list_contact_folders(
  client: Client,
  mailbox_id: string,
): Promise<GraphContactFolder[]> {
  return read_owner_listing(client, { owner_id: mailbox_id, listing: 'contact folders' }, () =>
    read_folder_tree(client, mailbox_id),
  );
}

/** One read of the default Contacts folder and every folder below it. */
async function read_folder_tree(client: Client, mailbox_id: string): Promise<GraphContactFolder[]> {
  const base = mailbox_url(mailbox_id);
  const root = await get_json<FolderPayload>(
    client,
    `${base}/contactFolders/contacts`,
    CONTACTS_READ,
  );
  const folders: GraphContactFolder[] = [{ id: root.id, display_name: root.displayName, path: [] }];
  await walk_children(client, base, root.id, [], folders);
  return folders;
}

/** Appends every descendant of `parent_id`, depth first, so parents precede children. */
async function walk_children(
  client: Client,
  base: string,
  parent_id: string,
  parent_path: readonly string[],
  out: GraphContactFolder[],
): Promise<void> {
  const children = await collect_listing<FolderPayload>(
    client,
    `${base}/contactFolders/${encodeURIComponent(parent_id)}/childFolders`,
    CONTACTS_READ,
    'contact folders',
  );
  for (const child of children) {
    // Exchange rejects a sibling whose name differs only in case, so a path names one folder.
    const path = [...parent_path, child.displayName];
    out.push({ id: child.id, display_name: child.displayName, path });
    await walk_children(client, base, child.id, path, out);
  }
}

/** Creates a child folder under `parent_folder_id`. The returned path is empty: callers key folders by id. */
export async function create_contact_folder(
  client: Client,
  mailbox_id: string,
  parent_folder_id: string,
  display_name: string,
): Promise<GraphContactFolder> {
  const url = `${mailbox_url(mailbox_id)}/contactFolders/${encodeURIComponent(parent_folder_id)}/childFolders`;
  const created: unknown = await graph_call(
    CONTACTS_READ_WRITE,
    (signal) => client.api(url).option('signal', signal).post({ displayName: display_name }),
    CREATE_ONCE,
  );
  return {
    id: string_field(created, 'id'),
    display_name: string_field(created, 'displayName'),
    path: [],
  };
}
