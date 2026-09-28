import { inject, injectable } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import { ResponseType } from '@microsoft/microsoft-graph-client';
import {
  GRAPH_CLIENT_TOKEN,
  is_invalid_delta_error,
  rethrow_if_access_denied,
  with_graph_retry,
} from '@wisecom/atlas-m365-graph';
import { run_with_graph_operation } from '@wisecom/atlas-core/services/shared/graph-request-context';
import type { ContactChange, ContactConnector, ContactFolder } from '@wisecom/atlas-types';
import { CONTACT_FIELDS } from '@/shared/contact-fields';

const IMMUTABLE_IDS = 'IdType="ImmutableId"';
const CONTACT_SELECT = `?$select=id,${CONTACT_FIELDS.join(',')}`;
type Page = { value: unknown; '@odata.nextLink'?: string; '@odata.deltaLink'?: string };

function records(page: Page): Record<string, unknown>[] {
  if (!Array.isArray(page.value))
    throw new Error('Invalid Graph contacts response: missing value array');
  return page.value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Invalid Graph contacts response: malformed item');
    }
    return item as Record<string, unknown>;
  });
}

@injectable()
export class GraphContactConnector implements ContactConnector {
  constructor(@inject(GRAPH_CLIENT_TOKEN) private readonly _client: Client) {}

  private async request<T>(url: string, kind: string): Promise<T> {
    try {
      return await run_with_graph_operation({ pool: 'outlook', request_type: kind }, () =>
        with_graph_retry(
          () => this._client.api(url).header('Prefer', IMMUTABLE_IDS).get() as Promise<T>,
        ),
      );
    } catch (err) {
      rethrow_if_access_denied(err);
      throw err;
    }
  }

  private async mutate<T>(kind: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await run_with_graph_operation({ pool: 'outlook', request_type: kind }, operation);
    } catch (err) {
      rethrow_if_access_denied(err);
      throw err;
    }
  }

  private async collect(url: string, kind: string): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [];
    let next: string | undefined = url;
    while (next) {
      const page: Page = await this.request<Page>(next, kind);
      all.push(...records(page));
      const candidate = page['@odata.nextLink'];
      if (candidate !== undefined && typeof candidate !== 'string')
        throw new Error('Invalid Graph contacts next link');
      next = candidate;
    }
    return all;
  }

  /** Walks the default Contacts folder and its descendants without losing nested folders. */
  async list_contact_folders(_tenant_id: string, owner_id: string): Promise<ContactFolder[]> {
    const root: unknown = await this.request(
      `/users/${encodeURIComponent(owner_id)}/contactFolders('contacts')`,
      'list_contact_folders',
    );
    if (
      !root ||
      typeof root !== 'object' ||
      !('id' in root) ||
      typeof root.id !== 'string' ||
      !root.id
    )
      throw new Error('Default contacts folder has no ID');
    const root_id: string = root.id;
    const owner_path = `/users/${encodeURIComponent(owner_id)}`;
    const children = await this.collect(`${owner_path}/contactFolders`, 'list_contact_folders');
    const folders: ContactFolder[] = [
      {
        folder_id: root_id,
        display_name:
          'displayName' in root && typeof root.displayName === 'string'
            ? root.displayName
            : 'Contacts',
        is_default: true,
      },
    ];
    const queue = children.map((record) => ({ record, parent_id: root_id, depth: 1 }));
    const seen = new Set([root_id]);
    for (let i = 0; i < queue.length; i++) {
      const { record, parent_id, depth } = queue[i]!;
      if (depth > 300) throw new Error('Contact folder hierarchy exceeds 300 levels');
      if (typeof record.id !== 'string' || !record.id || typeof record.displayName !== 'string') {
        throw new Error('Contact folder has no ID or display name');
      }
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      folders.push({
        folder_id: record.id,
        display_name: record.displayName,
        parent_folder_id: parent_id,
        is_default: false,
      });
      const nested = await this.collect(
        `${owner_path}/contactFolders/${encodeURIComponent(record.id)}/childFolders`,
        'list_contact_folders',
      );
      for (const child of nested)
        queue.push({ record: child, parent_id: record.id, depth: depth + 1 });
    }
    return folders;
  }

  /** Streams contact delta pages; an incomplete page never produces a committed delta link. */
  async fetch_contact_delta(
    _tenant_id: string,
    owner_id: string,
    folder_id: string,
    delta_link: string | undefined,
    on_page: (changes: ContactChange[]) => Promise<boolean>,
  ): Promise<{ delta_link?: string; reset: boolean }> {
    const initial = `/users/${encodeURIComponent(owner_id)}/contactFolders/${encodeURIComponent(folder_id)}/contacts/delta${CONTACT_SELECT}`;
    let pages_delivered = 0;
    const fetch = async (
      start: string,
      reset: boolean,
    ): Promise<{ delta_link?: string; reset: boolean }> => {
      let next: string | undefined = start;
      while (next) {
        const page: Page = await this.request<Page>(next, 'contact_delta');
        const changes: ContactChange[] = records(page).map((item) => {
          if (typeof item.id !== 'string' || !item.id)
            throw new Error('Contact delta item has no ID');
          return {
            contact_id: item.id,
            removed: item['@removed'] !== undefined,
            ...(!item['@removed'] ? { payload: item } : {}),
          };
        });
        if (!(await on_page(changes))) return { reset };
        pages_delivered++;
        const candidate = page['@odata.nextLink'];
        if (candidate !== undefined && typeof candidate !== 'string')
          throw new Error('Invalid Graph contacts next link');
        next = candidate;
        if (!next) {
          const link = page['@odata.deltaLink'];
          if (typeof link !== 'string' || !link)
            throw new Error('Contact delta response has no delta link');
          return { delta_link: link, reset };
        }
      }
      throw new Error('Contact delta returned no page');
    };
    try {
      return await fetch(delta_link ?? initial, false);
    } catch (err) {
      if (delta_link && pages_delivered === 0 && is_invalid_delta_error(err))
        return fetch(initial, true);
      throw err;
    }
  }

  async fetch_contact(
    _tenant_id: string,
    owner_id: string,
    contact_id: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/users/${encodeURIComponent(owner_id)}/contacts/${encodeURIComponent(contact_id)}${CONTACT_SELECT}`,
      'fetch_contact',
    );
  }

  async fetch_contact_photo(
    _tenant_id: string,
    owner_id: string,
    contact_id: string,
  ): Promise<Buffer | undefined> {
    try {
      const data = await run_with_graph_operation(
        { pool: 'outlook', request_type: 'fetch_contact_photo' },
        () =>
          with_graph_retry(
            () =>
              this._client
                .api(
                  `/users/${encodeURIComponent(owner_id)}/contacts/${encodeURIComponent(contact_id)}/photo/$value`,
                )
                .header('Prefer', IMMUTABLE_IDS)
                .responseType(ResponseType.ARRAYBUFFER)
                .get() as Promise<ArrayBuffer>,
          ),
      );
      return Buffer.from(data);
    } catch (err) {
      if (err && typeof err === 'object' && 'statusCode' in err && err.statusCode === 404)
        return undefined;
      rethrow_if_access_denied(err);
      throw err;
    }
  }

  async create_contact_folder(
    _tenant_id: string,
    owner_id: string,
    name: string,
    parent_folder_id?: string,
  ): Promise<string> {
    const path = `/users/${encodeURIComponent(owner_id)}/contactFolders`;
    const url = parent_folder_id
      ? `${path}/${encodeURIComponent(parent_folder_id)}/childFolders`
      : path;
    const response: unknown = await this.mutate('create_contact_folder', () =>
      this._client.api(url).header('Prefer', IMMUTABLE_IDS).post({ displayName: name }),
    );
    if (
      !response ||
      typeof response !== 'object' ||
      !('id' in response) ||
      typeof response.id !== 'string'
    )
      throw new Error('Created contact folder has no ID');
    return response.id;
  }

  async list_contacts(
    _tenant_id: string,
    owner_id: string,
    folder_id: string,
  ): Promise<Record<string, unknown>[]> {
    const contacts = await this.collect(
      `/users/${encodeURIComponent(owner_id)}/contactFolders/${encodeURIComponent(folder_id)}/contacts${CONTACT_SELECT}`,
      'list_contacts',
    );
    if (contacts.some((contact) => typeof contact.id !== 'string')) {
      throw new Error('Graph contact list contains an item without an ID');
    }
    return contacts;
  }

  async create_contact(
    _tenant_id: string,
    owner_id: string,
    folder_id: string,
    data: Record<string, unknown>,
  ): Promise<string> {
    const response: unknown = await this.mutate('create_contact', () =>
      this._client
        .api(
          `/users/${encodeURIComponent(owner_id)}/contactFolders/${encodeURIComponent(folder_id)}/contacts`,
        )
        .header('Prefer', IMMUTABLE_IDS)
        .post(data),
    );
    if (
      !response ||
      typeof response !== 'object' ||
      !('id' in response) ||
      typeof response.id !== 'string'
    )
      throw new Error('Created contact has no ID');
    return response.id;
  }

  async update_contact(
    _tenant_id: string,
    owner_id: string,
    contact_id: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.mutate('update_contact', () =>
      this._client
        .api(`/users/${encodeURIComponent(owner_id)}/contacts/${encodeURIComponent(contact_id)}`)
        .header('Prefer', IMMUTABLE_IDS)
        .patch(data),
    );
  }

  async set_contact_photo(
    _tenant_id: string,
    owner_id: string,
    contact_id: string,
    data: Buffer,
  ): Promise<void> {
    await this.mutate('set_contact_photo', () =>
      this._client
        .api(
          `/users/${encodeURIComponent(owner_id)}/contacts/${encodeURIComponent(contact_id)}/photo/$value`,
        )
        .header('Prefer', IMMUTABLE_IDS)
        .header('Content-Type', 'image/jpeg')
        .put(data),
    );
  }
}
