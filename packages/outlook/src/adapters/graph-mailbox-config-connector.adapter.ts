import { inject, injectable } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import {
  GRAPH_CLIENT_TOKEN,
  rethrow_if_access_denied,
  rethrow_if_mailbox_not_licensed,
  with_graph_retry,
} from '@wisecom/atlas-m365-graph';
import { run_with_graph_operation } from '@wisecom/atlas-core/services/shared/graph-request-context';
import type { MailboxConfigConnector, MailboxConfigSource } from '@wisecom/atlas-types';

const READ_PERMISSIONS = [
  'MailboxSettings.Read   -- back up inbox rules, categories, and mailbox settings',
] as const;
const WRITE_PERMISSIONS = [
  'MailboxSettings.ReadWrite -- restore inbox rules, categories, and mailbox settings',
] as const;

type JsonRecord = Record<string, unknown>;

function as_record(value: unknown, what: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Graph ${what} response`);
  }
  return value as JsonRecord;
}

/** Response metadata that varies per request; `@odata.type` stays because PATCH needs it. */
const VOLATILE_ANNOTATIONS = new Set(['@odata.context', '@odata.etag', '@odata.id']);

/** Drops per-request annotations so an unchanged mailbox hashes to the same document. */
function without_annotations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(without_annotations);
  if (!value || typeof value !== 'object') return value;
  const result: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    if (!VOLATILE_ANNOTATIONS.has(key)) result[key] = without_annotations(item);
  }
  return result;
}

@injectable()
export class GraphMailboxConfigConnector implements MailboxConfigConnector {
  constructor(@inject(GRAPH_CLIENT_TOKEN) private readonly _client: Client) {}

  /** Reads rules, categories, and settings with one call each, failing fast on a denied grant. */
  async fetch_mailbox_config(_tenant_id: string, owner_id: string): Promise<MailboxConfigSource> {
    const user = `/users/${encodeURIComponent(owner_id)}`;
    const message_rules = await this.collect(
      `${user}/mailFolders/inbox/messageRules`,
      'list_message_rules',
    );
    const master_categories = await this.collect(
      `${user}/outlook/masterCategories`,
      'list_master_categories',
    );
    const mailbox_settings = as_record(
      without_annotations(await this.read(`${user}/mailboxSettings`, 'get_mailbox_settings')),
      'mailbox settings',
    );
    return { message_rules, master_categories, mailbox_settings };
  }

  async create_master_category(
    _tenant_id: string,
    owner_id: string,
    category: JsonRecord,
  ): Promise<void> {
    await this.write('create_master_category', () =>
      this._client
        .api(`/users/${encodeURIComponent(owner_id)}/outlook/masterCategories`)
        .post(category),
    );
  }

  async update_master_category_color(
    _tenant_id: string,
    owner_id: string,
    category_id: string,
    color: string,
  ): Promise<void> {
    await this.write('update_master_category', () =>
      this._client
        .api(
          `/users/${encodeURIComponent(owner_id)}/outlook/masterCategories/${encodeURIComponent(category_id)}`,
        )
        .patch({ color }),
    );
  }

  async update_mailbox_settings(
    _tenant_id: string,
    owner_id: string,
    settings: JsonRecord,
  ): Promise<void> {
    await this.write('update_mailbox_settings', () =>
      this._client.api(`/users/${encodeURIComponent(owner_id)}/mailboxSettings`).patch(settings),
    );
  }

  async create_message_rule(_tenant_id: string, owner_id: string, rule: JsonRecord): Promise<void> {
    await this.write('create_message_rule', () =>
      this._client
        .api(`/users/${encodeURIComponent(owner_id)}/mailFolders/inbox/messageRules`)
        .post(rule),
    );
  }

  async update_message_rule(
    _tenant_id: string,
    owner_id: string,
    rule_id: string,
    rule: JsonRecord,
  ): Promise<void> {
    await this.write('update_message_rule', () =>
      this._client
        .api(
          `/users/${encodeURIComponent(owner_id)}/mailFolders/inbox/messageRules/${encodeURIComponent(rule_id)}`,
        )
        .patch(rule),
    );
  }

  private async read(url: string, kind: string): Promise<unknown> {
    try {
      return await run_with_graph_operation({ pool: 'outlook', request_type: kind }, () =>
        with_graph_retry(() => this._client.api(url).get() as Promise<unknown>),
      );
    } catch (err) {
      rethrow_if_mailbox_not_licensed(err);
      rethrow_if_access_denied(err, READ_PERMISSIONS);
      throw err;
    }
  }

  private async write(kind: string, operation: () => Promise<unknown>): Promise<void> {
    try {
      await run_with_graph_operation({ pool: 'outlook', request_type: kind }, operation);
    } catch (err) {
      rethrow_if_mailbox_not_licensed(err);
      rethrow_if_access_denied(err, WRITE_PERMISSIONS);
      throw err;
    }
  }

  private async collect(url: string, kind: string): Promise<JsonRecord[]> {
    const items: JsonRecord[] = [];
    const seen = new Set<string>();
    let next: string | undefined = url;
    while (next) {
      if (seen.has(next)) throw new Error('Graph response repeated a next link');
      seen.add(next);
      const page = as_record(await this.read(next, kind), kind);
      if (!Array.isArray(page.value)) throw new Error(`Invalid Graph ${kind} response`);
      const values: unknown[] = page.value;
      for (const item of values) items.push(as_record(without_annotations(item), kind));
      const link = page['@odata.nextLink'];
      if (link !== undefined && typeof link !== 'string') {
        throw new Error(`Invalid Graph ${kind} next link`);
      }
      next = link;
    }
    return items;
  }
}
