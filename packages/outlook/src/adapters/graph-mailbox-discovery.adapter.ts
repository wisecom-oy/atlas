/**
 * Graph API adapter for discovering tenant mailboxes with Exchange license information.
 * Queries /users with assignedPlans to detect Exchange Online licensing,
 * and enriches with mailbox size from the usage reports API when available.
 */

import { inject, injectable } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import { GRAPH_CLIENT_TOKEN } from '@wisecom/atlas-m365-graph';
import type {
  MailboxDiscoveryService,
  MailboxDiscoveryOptions,
  TenantMailbox,
} from '@wisecom/atlas-types';
import type { GraphUserRecord } from '@/adapters/graph-mailbox-response-mappers';
import { map_users_to_tenant_mailboxes } from '@/adapters/graph-mailbox-response-mappers';
import { rethrow_if_access_denied, with_graph_retry } from '@wisecom/atlas-m365-graph';
import { logger } from '@wisecom/atlas-core/utils/logger';

const USERS_SELECT = 'id,mail,displayName,createdDateTime,assignedPlans';
const USERS_URL = `/users?$select=${USERS_SELECT}&$top=999`;
const USAGE_REPORT_URL = "/reports/getMailboxUsageDetail(period='D7')";

interface GraphPageResponse {
  value?: GraphUserRecord[];
  '@odata.nextLink'?: string;
}

interface MailboxUsageRow {
  upn: string;
  storage_bytes: number;
  item_count: number;
}

@injectable()
export class GraphMailboxDiscoveryAdapter implements MailboxDiscoveryService {
  constructor(@inject(GRAPH_CLIENT_TOKEN) private readonly _client: Client) {}

  /** Lists tenant mailboxes, optionally filtering to Exchange-licensed only. */
  async list_tenant_mailboxes(
    _tenant_id: string,
    options?: MailboxDiscoveryOptions,
  ): Promise<TenantMailbox[]> {
    try {
      const users = await with_graph_retry(() => this.collectAllUsers());
      let mailboxes = map_users_to_tenant_mailboxes(users);

      if (options?.licensed_only) {
        mailboxes = mailboxes.filter((m) => m.has_exchange_license);
      }

      const usage = await this.fetchMailboxUsage();
      if (usage.size > 0) {
        mailboxes = mailboxes.map((m) => {
          const row = usage.get(m.mail.toLowerCase());
          if (!row) return m;
          return { ...m, mailbox_size_bytes: row.storage_bytes, item_count: row.item_count };
        });
      }

      return mailboxes;
    } catch (err) {
      rethrow_if_access_denied(err);
      throw err;
    }
  }

  private async collectAllUsers(): Promise<GraphUserRecord[]> {
    const all: GraphUserRecord[] = [];
    let url: string | undefined = USERS_URL;

    while (url) {
      const page: GraphPageResponse = await this._client
        .api(url)
        .header('Prefer', 'odata.maxpagesize=999')
        .get();

      if (page.value) {
        all.push(...page.value);
      }
      url = page['@odata.nextLink'];
    }

    return all;
  }

  /** Fetches the mailbox usage report CSV. Returns empty map if Reports.Read.All is missing. */
  private async fetchMailboxUsage(): Promise<Map<string, MailboxUsageRow>> {
    try {
      const csv: string = await this._client.api(USAGE_REPORT_URL).get();
      return parse_usage_csv(csv);
    } catch {
      logger.debug('Mailbox usage report unavailable (Reports.Read.All may not be granted)');
      return new Map();
    }
  }
}

/** Parses the CSV from getMailboxUsageDetail into a UPN-keyed map. */
export function parse_usage_csv(csv: string): Map<string, MailboxUsageRow> {
  const map = new Map<string, MailboxUsageRow>();
  const lines = csv.split(/\r?\n/);
  if (lines.length < 2) return map;

  const header = lines[0]!;
  const cols = split_csv_line(header).map((h) => h.trim());
  const upn_idx = cols.indexOf('User Principal Name');
  const storage_idx = cols.indexOf('Storage Used (Byte)');
  const items_idx = cols.indexOf('Item Count');

  if (upn_idx < 0 || storage_idx < 0) return map;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const fields = split_csv_line(line);
    const upn = fields[upn_idx]?.trim().toLowerCase();
    if (!upn) continue;

    map.set(upn, {
      upn,
      storage_bytes: parseInt(fields[storage_idx] ?? '0', 10) || 0,
      item_count: items_idx >= 0 ? parseInt(fields[items_idx] ?? '0', 10) || 0 : 0,
    });
  }

  return map;
}

function split_csv_line(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let in_quotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      const is_escaped_quote = in_quotes && line[i + 1] === '"';
      if (is_escaped_quote) {
        current += '"';
        i++;
        continue;
      }
      in_quotes = !in_quotes;
      continue;
    }

    if (ch === ',' && !in_quotes) {
      fields.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  fields.push(current);
  return fields;
}
