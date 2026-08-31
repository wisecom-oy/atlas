/**
 * Graph API adapter for discovering tenant mailboxes with Exchange license information.
 * Queries /users with assignedPlans to detect Exchange Online licensing,
 * resolves mailboxSettings.userPurpose for unlicensed mailboxes (shared-mailbox detection),
 * and enriches with mailbox size from the usage reports API when available.
 */

import { inject, injectable } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import { GRAPH_CLIENT_TOKEN } from '@wisecom/atlas-m365-graph';
import type {
  MailboxDiscoveryService,
  MailboxDiscoveryOptions,
  MailboxPurpose,
  TenantMailbox,
} from '@wisecom/atlas-types';
import type { GraphUserRecord } from '@/adapters/graph-mailbox-response-mappers';
import {
  map_users_to_tenant_mailboxes,
  parse_mailbox_purpose,
} from '@/adapters/graph-mailbox-response-mappers';
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
  has_archive?: boolean;
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
      const users = await this.collectAllUsers();
      let mailboxes = map_users_to_tenant_mailboxes(users);

      if (options?.licensed_only) {
        mailboxes = mailboxes.filter((m) => m.has_exchange_license);
      }

      // ponytail: purpose fetched for unlicensed only; per-user N+1 at concurrency 5 — switch to Graph $batch if unlicensed counts make discovery slow
      const unlicensed_ids = mailboxes.filter((m) => !m.has_exchange_license).map((m) => m.user_id);
      const purposes = await this.fetchPurposes(unlicensed_ids);
      if (purposes.size > 0) {
        mailboxes = mailboxes.map((m) => {
          const p = purposes.get(m.user_id);
          return p ? { ...m, mailbox_purpose: p } : m;
        });
      }

      const usage = await this.fetchMailboxUsage();
      if (usage.size > 0) {
        mailboxes = mailboxes.map((m) => {
          const row = usage.get(m.mail.toLowerCase());
          if (!row) return m;
          return {
            ...m,
            mailbox_size_bytes: row.storage_bytes,
            item_count: row.item_count,
            ...(row.has_archive === undefined ? {} : { has_in_place_archive: row.has_archive }),
          };
        });
      }

      return mailboxes;
    } catch (err) {
      rethrow_if_access_denied(err);
      throw err;
    }
  }

  /**
   * Pages through /users, retrying each page individually so a failed page
   * resumes from the current @odata.nextLink. NEVER wrap this whole loop in
   * with_graph_retry -- the 60s per-request timeout would race the entire
   * enumeration and restart it from page 1 (issue #33).
   */
  private async collectAllUsers(): Promise<GraphUserRecord[]> {
    const all: GraphUserRecord[] = [];
    let url: string | undefined = USERS_URL;

    while (url) {
      const current_url = url;
      const page: GraphPageResponse = await with_graph_retry(() =>
        this._client.api(current_url).header('Prefer', 'odata.maxpagesize=999').get(),
      );

      if (page.value) {
        all.push(...page.value);
      }
      url = page['@odata.nextLink'];
    }

    return all;
  }

  /** Resolves mailboxSettings.userPurpose per user at bounded concurrency; failed lookups are logged and skipped. */
  private async fetchPurposes(user_ids: string[]): Promise<Map<string, MailboxPurpose>> {
    const CONCURRENCY = 5;
    const purposes = new Map<string, MailboxPurpose>();
    const queue = [...user_ids];

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const user_id = queue.shift()!;
        try {
          const res = await with_graph_retry(() =>
            this._client.api(`/users/${user_id}/mailboxSettings?$select=userPurpose`).get(),
          );
          const purpose = parse_mailbox_purpose(
            (res as { userPurpose?: unknown } | undefined)?.userPurpose,
          );
          if (purpose) purposes.set(user_id, purpose);
        } catch (err) {
          // Purpose is optional metadata; a 403/404 here must never fail discovery.
          // But an undetected shared mailbox is silently excluded from tenant backup, so make it visible.
          logger.warn(
            `Could not resolve mailbox purpose for ${user_id}; ` +
              `if this is a shared mailbox it will be skipped by tenant backup (${(err as Error).message})`,
          );
        }
      }
    };

    const workers = Array.from({ length: Math.min(CONCURRENCY, user_ids.length) }, () => worker());
    await Promise.all(workers);
    return purposes;
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
  // Documented on getMailboxUsageDetail, but absent from the example schema in
  // the same reference page, so it is treated as optional rather than assumed.
  const archive_idx = cols.indexOf('Has Archive');

  if (upn_idx < 0 || storage_idx < 0) return map;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const fields = split_csv_line(line);
    const upn = fields[upn_idx]?.trim().toLowerCase();
    if (!upn) continue;

    const has_archive = archive_idx >= 0 ? parse_csv_boolean(fields[archive_idx]) : undefined;

    map.set(upn, {
      upn,
      storage_bytes: parseInt(fields[storage_idx] ?? '0', 10) || 0,
      item_count: items_idx >= 0 ? parseInt(fields[items_idx] ?? '0', 10) || 0 : 0,
      ...(has_archive === undefined ? {} : { has_archive }),
    });
  }

  return map;
}

/**
 * Reads a usage-report boolean, returning undefined for a blank or unrecognised
 * value so a parse miss cannot be mistaken for a definite "false".
 */
function parse_csv_boolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '') return undefined;
  if (['true', 'yes', '1'].includes(normalized)) return true;
  if (['false', 'no', '0'].includes(normalized)) return false;
  return undefined;
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
