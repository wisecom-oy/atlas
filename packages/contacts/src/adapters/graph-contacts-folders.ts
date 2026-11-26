import type { Client } from '@microsoft/microsoft-graph-client';
import type { GraphContactFolder } from '@wisecom/atlas-types';
import {
  create_repeated_listing_filter,
  read_owner_listing,
  type RepeatedListingFilter,
} from '@wisecom/atlas-m365-graph';
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
 * believed, since the listing decides whether the run happens (#864). A folder Graph lists twice,
 * on one page, across pages or under two parents, is returned once, at its first copy, and its
 * subtree is walked once (#964). Every copy still counts toward its listing's `@odata.count` check.
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

/** The state one walk of the folder tree shares across every level. */
interface FolderWalk {
  readonly client: Client;
  readonly base: string;
  /** Drops a folder any earlier listing in this walk returned. */
  readonly keep_first_listing: RepeatedListingFilter<FolderPayload>;
  readonly out: GraphContactFolder[];
}

/** One read of the default Contacts folder and every folder below it. */
async function read_folder_tree(client: Client, mailbox_id: string): Promise<GraphContactFolder[]> {
  const base = mailbox_url(mailbox_id);
  const root = await get_json<FolderPayload>(
    client,
    `${base}/contactFolders/contacts`,
    CONTACTS_READ,
  );
  const walk: FolderWalk = {
    client,
    base,
    keep_first_listing: create_repeated_listing_filter((folder) => folder.id, [root.id]),
    out: [{ id: root.id, display_name: root.displayName, path: [] }],
  };
  await walk_children(walk, root.id, []);
  return walk.out;
}

/** Appends every descendant of `parent_id`, depth first, so parents precede children. */
async function walk_children(
  walk: FolderWalk,
  parent_id: string,
  parent_path: readonly string[],
): Promise<void> {
  const listed = await collect_listing<FolderPayload>(
    walk.client,
    `${walk.base}/contactFolders/${encodeURIComponent(parent_id)}/childFolders`,
    CONTACTS_READ,
    'contact folders',
  );
  // After the count check inside collect_listing, so a repeat still counts toward it (#853).
  for (const child of walk.keep_first_listing(listed)) {
    // Exchange rejects a sibling whose name differs only in case, so a path names one folder.
    const path = [...parent_path, child.displayName];
    walk.out.push({ id: child.id, display_name: child.displayName, path });
    await walk_children(walk, child.id, path);
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
