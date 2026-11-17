import type { Client } from '@microsoft/microsoft-graph-client';
import { get_graph_bytes } from '@wisecom/atlas-m365-graph';
import { extended_properties_expand } from '@wisecom/atlas-core/services/shared/atlas-extended-property';
import type { GraphContactPayload } from '@wisecom/atlas-types';
import {
  CONTACTS_READ,
  CONTACTS_READ_WRITE,
  CREATE_ONCE,
  IMMUTABLE_ID_PREFER,
  collect_pages,
  graph_call,
  is_not_found,
  mailbox_url,
  string_field,
} from '@/adapters/graph-contacts-requests';
import { SOURCE_CONTACT_PROPERTY_ID } from '@/services/shared/source-tag';

/** The fields restore matches on: identity fields plus the Atlas source tag. */
const MATCH_QUERY =
  '$select=displayName,emailAddresses,businessPhones,homePhones,mobilePhone,companyName' +
  `&$top=100&$expand=${extended_properties_expand([SOURCE_CONTACT_PROPERTY_ID])}`;

function folder_contacts_url(mailbox_id: string, folder_id: string): string {
  return `${mailbox_url(mailbox_id)}/contactFolders/${encodeURIComponent(folder_id)}/contacts`;
}

function contact_url(mailbox_id: string, folder_id: string, contact_id: string): string {
  return `${folder_contacts_url(mailbox_id, folder_id)}/${encodeURIComponent(contact_id)}`;
}

/**
 * Lists every contact currently in a folder under its immutable id, which is the id a backup
 * records, with the fields restore matches on and the Atlas source tag.
 */
export async function list_folder_contacts(
  client: Client,
  mailbox_id: string,
  folder_id: string,
): Promise<GraphContactPayload[]> {
  return collect_pages<GraphContactPayload>(
    client,
    `${folder_contacts_url(mailbox_id, folder_id)}?${MATCH_QUERY}`,
    CONTACTS_READ,
    IMMUTABLE_ID_PREFER,
  );
}

/** Reads a contact's photo bytes; a 404 means the contact has no photo. */
export async function fetch_contact_photo(
  client: Client,
  mailbox_id: string,
  folder_id: string,
  contact_id: string,
): Promise<Uint8Array | undefined> {
  const url = `${contact_url(mailbox_id, folder_id, contact_id)}/photo/$value`;
  try {
    const body = await graph_call(CONTACTS_READ, () => get_graph_bytes(client.api(url)));
    return new Uint8Array(body);
  } catch (err) {
    if (is_not_found(err)) return undefined;
    throw err;
  }
}

/** Creates a contact in a folder and returns its id. */
export async function create_contact(
  client: Client,
  mailbox_id: string,
  folder_id: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<string> {
  const created: unknown = await graph_call(
    CONTACTS_READ_WRITE,
    (signal) =>
      client.api(folder_contacts_url(mailbox_id, folder_id)).option('signal', signal).post(payload),
    CREATE_ONCE,
  );
  return string_field(created, 'id');
}

/** Sets a contact's photo to JPEG-typed bytes. */
export async function upload_contact_photo(
  client: Client,
  mailbox_id: string,
  folder_id: string,
  contact_id: string,
  photo: Uint8Array,
): Promise<void> {
  const url = `${contact_url(mailbox_id, folder_id, contact_id)}/photo/$value`;
  await graph_call(CONTACTS_READ_WRITE, () =>
    client.api(url).header('Content-Type', 'image/jpeg').put(Buffer.from(photo)),
  );
}
