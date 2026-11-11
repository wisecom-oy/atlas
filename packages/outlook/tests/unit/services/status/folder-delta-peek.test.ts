import { describe, expect, it, vi } from 'vitest';
import { AuthError, MailboxNotLicensedError } from '@wisecom/atlas-types';
import type {
  DeltaSyncResult,
  MailboxConnector,
  MailFolder,
  MailMessage,
} from '@wisecom/atlas-types';
import {
  peek_folder_or_record_error,
  STATUS_PEEK_MAX_PAGES,
} from '@/services/status/folder-delta-peek';

const FOLDER: MailFolder = {
  folder_id: 'f1',
  display_name: 'Inbox',
  folder_path: 'Inbox',
  total_item_count: 10,
};

function message(n: number): MailMessage {
  return {
    message_id: `msg-${n}`,
    folder_id: 'f1',
    subject: 'x',
    received_at: new Date(0),
    size_bytes: 1,
    raw_body: Buffer.from('x'),
    has_attachments: false,
  };
}

/**
 * A connector whose delta holds `pages` pages of `per_page` messages and `removed` removals, and
 * that pages the way the Graph adapter does: it stops when `on_page` returns false, and only the
 * final page carries the delta link.
 */
function paged_connector(pages: number, per_page: number, removed = 0): MailboxConnector {
  const fetch_delta = vi.fn(async (_t, _o, _f, _link, on_page): Promise<DeltaSyncResult> => {
    let n = 0;
    for (let page = 1; page <= pages; page++) {
      const batch = Array.from({ length: per_page }, () => message(++n));
      if ((await on_page?.(page, n, batch)) === false && page < pages) {
        return { messages: [], removed_ids: [], delta_link: '', delta_reset: false };
      }
    }
    const removed_ids = Array.from({ length: removed }, (_, i) => `del-${i}`);
    return { messages: [], removed_ids, delta_link: 'https://delta/next', delta_reset: false };
  });
  return { fetch_delta } as unknown as MailboxConnector;
}

const peek = (connector: MailboxConnector) =>
  peek_folder_or_record_error(connector, 't', 'owner', FOLDER, 'https://delta/saved');

describe('peek_folder_or_record_error (issue #630)', () => {
  it('counts every pending message across pages instead of stopping at one', async () => {
    const result = await peek(paged_connector(3, 4, 2));

    expect(result).toMatchObject({
      pending_new: 12,
      pending_removed: 2,
      pending_capped: false,
      is_up_to_date: false,
    });
  });

  it('stops at the page cap and flags the count as a lower bound', async () => {
    const connector = paged_connector(STATUS_PEEK_MAX_PAGES + 3, 2);
    const result = await peek(connector);

    expect(result.pending_new).toBe(STATUS_PEEK_MAX_PAGES * 2);
    expect(result.pending_capped).toBe(true);
  });

  it('does not flag a delta that ends exactly on the cap page', async () => {
    const result = await peek(paged_connector(STATUS_PEEK_MAX_PAGES, 2));

    expect(result.pending_new).toBe(STATUS_PEEK_MAX_PAGES * 2);
    expect(result.pending_capped).toBe(false);
  });

  it('reports an empty delta as up to date', async () => {
    const result = await peek(paged_connector(1, 0));

    expect(result).toMatchObject({ pending_new: 0, pending_removed: 0, is_up_to_date: true });
  });

  it.each([
    ['AuthError', new AuthError('403 Forbidden')],
    ['MailboxNotLicensedError', new MailboxNotLicensedError('unlicensed')],
  ])('rethrows %s instead of reporting the folder as pending', async (_name, err) => {
    const connector = { fetch_delta: vi.fn().mockRejectedValue(err) };

    await expect(peek(connector as unknown as MailboxConnector)).rejects.toBe(err);
  });

  it('rethrows a bare Graph 401 as an AuthError', async () => {
    const graph_401 = Object.assign(new Error('InvalidAuthenticationToken'), { statusCode: 401 });
    const connector = { fetch_delta: vi.fn().mockRejectedValue(graph_401) };

    await expect(peek(connector as unknown as MailboxConnector)).rejects.toBeInstanceOf(AuthError);
  });

  it('records a transient failure on the row with its error class', async () => {
    const connector = { fetch_delta: vi.fn().mockRejectedValue(new TypeError('fetch failed')) };
    const result = await peek(connector as unknown as MailboxConnector);

    expect(result).toMatchObject({
      has_backup: true,
      is_up_to_date: false,
      peek_error: 'TypeError: fetch failed',
    });
  });
});
