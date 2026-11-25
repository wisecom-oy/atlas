import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import type { MailMessage } from '@wisecom/atlas-types';
import type { GraphMailboxConnector } from '@/adapters/graph-mailbox-connector.adapter';
import type { MockClient } from './mailbox-connector.fixtures';
import { create_mock_client, create_connector } from './mailbox-connector.fixtures';

/**
 * Issue #851. A delta round whose last page carried neither `@odata.nextLink` nor
 * `@odata.deltaLink` was returned as finished with an empty link, so the folder was reported done
 * with the messages on the pages never requested missing.
 */

const NEXT_PAGE = 'https://graph.microsoft.com/delta?skiptoken=page2';
const DELTA_LINK = 'https://graph.microsoft.com/delta?token=next';
const STALE_LINK = 'https://graph.microsoft.com/delta?token=stale';
const INCOMPLETE = /without a delta link/;

/** A first page that continues, then a last page that has lost both links. */
function cut_round_short(mock_client: MockClient): void {
  mock_client._chain.get
    .mockResolvedValueOnce({
      value: [{ id: 'msg-1', subject: 'One' }],
      '@odata.nextLink': NEXT_PAGE,
    })
    .mockResolvedValueOnce({ value: [{ id: 'msg-2', subject: 'Two' }] });
}

function collect_handed_over(handed_over: string[]) {
  return (_page: number, _so_far: number, page_messages: MailMessage[]): boolean => {
    handed_over.push(...page_messages.map((message) => message.message_id));
    return true;
  };
}

describe('GraphMailboxConnector - a delta round that ends without a delta link', () => {
  let mock_client: MockClient;
  let connector: GraphMailboxConnector;

  beforeEach(() => {
    mock_client = create_mock_client();
    connector = create_connector(mock_client);
  });

  it('rejects after handing over the pages it read', async () => {
    cut_round_short(mock_client);
    const handed_over: string[] = [];

    const fetching = connector.fetch_delta(
      't',
      'u',
      'f-inbox',
      undefined,
      collect_handed_over(handed_over),
    );

    await expect(fetching).rejects.toThrow(INCOMPLETE);
    expect(handed_over).toEqual(['msg-1', 'msg-2']);
  });

  it('rejects when no page callback is given', async () => {
    cut_round_short(mock_client);

    await expect(connector.fetch_delta('t', 'u', 'f-inbox')).rejects.toThrow(INCOMPLETE);
  });

  it('rejects when the full re-read after an invalid delta link is cut short', async () => {
    mock_client._chain.get.mockRejectedValueOnce(
      new Error('SyncStateNotFound: delta token expired'),
    );
    cut_round_short(mock_client);

    await expect(connector.fetch_delta('t', 'u', 'f-inbox', STALE_LINK)).rejects.toThrow(
      INCOMPLETE,
    );
  });

  it('returns a single-page round that ends with a delta link', async () => {
    mock_client._chain.get.mockResolvedValueOnce({
      value: [{ id: 'msg-1', subject: 'One' }],
      '@odata.deltaLink': DELTA_LINK,
    });

    const result = await connector.fetch_delta('t', 'u', 'f-inbox', undefined, () => true);

    expect(result.delta_link).toBe(DELTA_LINK);
  });

  it('returns an empty link without rejecting when the callback stops the round early', async () => {
    cut_round_short(mock_client);

    const result = await connector.fetch_delta('t', 'u', 'f-inbox', undefined, () => false);

    expect(result.delta_link).toBe('');
    expect(mock_client._chain.get).toHaveBeenCalledOnce();
  });
});
