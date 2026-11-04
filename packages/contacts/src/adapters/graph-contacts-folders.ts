import type { Client } from '@microsoft/microsoft-graph-client';
import type { GraphContactFolder } from '@wisecom/atlas-types';
import {
  CONTACTS_READ,
  CONTACTS_READ_WRITE,
  collect_pages,
  get_json,
  graph_call,
  mailbox_url,
  string_field,
} from '@/adapters/graph-contacts-requests';

interface FolderPayload {
  readonly id: string;
  readonly displayName: string;
}

/** Lists the default Contacts folder first, then every descendant folder with its display-name path. */
export async function list_contact_folders(
  client: Client,
  mailbox_id: string,
): Promise<GraphContactFolder[]> {
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
  const children = await collect_pages<FolderPayload>(
    client,
    `${base}/contactFolders/${encodeURIComponent(parent_id)}/childFolders`,
    CONTACTS_READ,
  );
  for (const child of children) {
    // ponytail: sibling folders sharing a display name share a path key; restore maps both onto the first.
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
  const created: unknown = await graph_call(CONTACTS_READ_WRITE, () =>
    client.api(url).post({ displayName: display_name }),
  );
  return {
    id: string_field(created, 'id'),
    display_name: string_field(created, 'displayName'),
    path: [],
  };
}
