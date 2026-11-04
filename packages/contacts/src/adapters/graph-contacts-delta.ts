import type { Client } from '@microsoft/microsoft-graph-client';
import { is_invalid_delta_error } from '@wisecom/atlas-m365-graph';
import type { ContactFolderDelta, GraphContactPayload } from '@wisecom/atlas-types';
import {
  CONTACTS_READ,
  IMMUTABLE_ID_PREFER,
  get_json,
  mailbox_url,
} from '@/adapters/graph-contacts-requests';

type DeltaItem = GraphContactPayload & { readonly '@removed'?: unknown };

interface DeltaPage {
  readonly value?: DeltaItem[];
  readonly '@odata.nextLink'?: string;
  readonly '@odata.deltaLink'?: string;
}

/** Reads one folder's contact changes; a rejected stored link re-reads the folder in full. */
export async function fetch_folder_delta(
  client: Client,
  mailbox_id: string,
  folder_id: string,
  delta_link?: string,
): Promise<ContactFolderDelta> {
  const full_url = `${mailbox_url(mailbox_id)}/contactFolders/${encodeURIComponent(folder_id)}/contacts/delta`;
  if (delta_link === undefined) return read_delta(client, full_url, false);
  try {
    return await read_delta(client, delta_link, false);
  } catch (err) {
    if (!is_invalid_delta_error(err)) throw err;
    return read_delta(client, full_url, true);
  }
}

/** Follows every delta page to the final delta link and splits upserts from removals. */
async function read_delta(
  client: Client,
  start_url: string,
  reset: boolean,
): Promise<ContactFolderDelta> {
  const items: DeltaItem[] = [];
  const seen = new Set<string>();
  let next: string | undefined = start_url;
  let delta_link: string | undefined;
  while (next !== undefined) {
    if (seen.has(next)) throw new Error('Contacts delta paging did not advance');
    seen.add(next);
    const page: DeltaPage = await get_json(client, next, CONTACTS_READ, IMMUTABLE_ID_PREFER);
    items.push(...(page.value ?? []));
    next = page['@odata.nextLink'];
    delta_link = page['@odata.deltaLink'] ?? delta_link;
  }
  if (delta_link === undefined) throw new Error('Contacts delta response carried no deltaLink');
  return {
    upserted: items.filter((item) => !('@removed' in item)),
    removed_ids: items.filter((item) => '@removed' in item).map((item) => item.id),
    delta_link,
    reset,
  };
}
