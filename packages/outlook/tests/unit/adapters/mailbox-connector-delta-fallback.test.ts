import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import type { MailMessage } from '@wisecom/atlas-types';
import type { GraphMailboxConnector } from '@/adapters/graph-mailbox-connector.adapter';
import type { MockClient } from './mailbox-connector.fixtures';
import { create_mock_client, create_connector } from './mailbox-connector.fixtures';

const STALE_LINK = 'https://graph.microsoft.com/delta?token=stale';
const FRESH_LINK = 'https://graph.microsoft.com/delta?token=fresh';

/** Graph accepts the stale link's first page, then rejects the next one as an expired sync state. */
function reject_stale_link_after_first_page(mock_client: MockClient): void {
  mock_client._chain.get
    .mockResolvedValueOnce({
      value: [
        { id: 'msg-1', subject: 'Changed 1' },
        { id: 'msg-gone', '@removed': { reason: 'deleted' } },
        { id: 'msg-2', subject: 'Changed 2' },
      ],
      '@odata.nextLink': 'https://graph.microsoft.com/delta?skiptoken=page2',
    })
    .mockRejectedValueOnce(new Error('SyncStateNotFound: delta token expired'))
    .mockResolvedValueOnce({
      value: [
        { id: 'msg-1', subject: 'Changed 1' },
        { id: 'msg-old', subject: 'Unchanged' },
      ],
      '@odata.nextLink': 'https://graph.microsoft.com/delta?skiptoken=full2',
    })
    .mockResolvedValueOnce({
      value: [{ id: 'msg-2', subject: 'Changed 2' }],
      '@odata.deltaLink': FRESH_LINK,
    });
}

describe('GraphMailboxConnector - invalid delta link rejected mid-paging (issue #642)', () => {
  let mock_client: MockClient;
  let connector: GraphMailboxConnector;

  beforeEach(() => {
    mock_client = create_mock_client();
    connector = create_connector(mock_client);
  });

  it('hands each message to on_page once across the full re-enumeration', async () => {
    reject_stale_link_after_first_page(mock_client);
    const handed_over: string[] = [];
    const on_page = (_page: number, _so_far: number, page_messages: MailMessage[]): boolean => {
      handed_over.push(...page_messages.map((message) => message.message_id));
      return true;
    };

    const result = await connector.fetch_delta('t', 'u', 'f-inbox', STALE_LINK, on_page);

    expect(handed_over).toEqual(['msg-1', 'msg-2', 'msg-old']);
    expect(result.delta_reset).toBe(true);
    expect(result.delta_link).toBe(FRESH_LINK);
  });

  it('keeps the removals read before the delta link was rejected', async () => {
    reject_stale_link_after_first_page(mock_client);

    const result = await connector.fetch_delta('t', 'u', 'f-inbox', STALE_LINK, () => true);

    expect(result.removed_ids).toEqual(['msg-gone']);
  });

  it('returns the re-enumeration once when no page callback is given', async () => {
    reject_stale_link_after_first_page(mock_client);

    const result = await connector.fetch_delta('t', 'u', 'f-inbox', STALE_LINK);

    expect(result.messages.map((message) => message.message_id)).toEqual([
      'msg-1',
      'msg-old',
      'msg-2',
    ]);
    expect(result.removed_ids).toEqual(['msg-gone']);
  });
});
