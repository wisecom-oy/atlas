import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import type { MailMessage } from '@wisecom/atlas-types';
import type { GraphMailboxConnector } from '@/adapters/graph-mailbox-connector.adapter';
import type { MockClient } from './mailbox-connector.fixtures';
import { create_mock_client, create_connector } from './mailbox-connector.fixtures';

const STALE_LINK = 'https://graph.microsoft.com/delta?token=stale';
const NEXT_LINK = 'https://graph.microsoft.com/delta?skiptoken=next';
const FRESH_LINK = 'https://graph.microsoft.com/delta?token=fresh';

const gone = (id: string) => ({ id, '@removed': { reason: 'deleted' } });

/** Serves the pages in order; every page but the last links to the next. */
function serve_round(mock_client: MockClient, ...pages: Record<string, unknown>[][]): void {
  pages.forEach((value, index) => {
    const link =
      index === pages.length - 1
        ? { '@odata.deltaLink': FRESH_LINK }
        : { '@odata.nextLink': NEXT_LINK };
    mock_client._chain.get.mockResolvedValueOnce({ value, ...link });
  });
}

/** Runs fetch_delta with a page callback and returns the IDs handed over, in order. */
async function hand_over(connector: GraphMailboxConnector, prev_link?: string) {
  const handed_over: string[] = [];
  const on_page = (_page: number, _so_far: number, page_messages: MailMessage[]): boolean => {
    handed_over.push(...page_messages.map((message) => message.message_id));
    return true;
  };
  const result = await connector.fetch_delta('t', 'u', 'f-inbox', prev_link, on_page);
  return { handed_over, removed_ids: result.removed_ids };
}

describe('GraphMailboxConnector - a message listed more than once in a round (issue #894)', () => {
  let mock_client: MockClient;
  let connector: GraphMailboxConnector;

  beforeEach(() => {
    mock_client = create_mock_client();
    connector = create_connector(mock_client);
  });

  it('hands a message repeated on one page over once', async () => {
    serve_round(mock_client, [{ id: 'msg-1' }, { id: 'msg-2' }, { id: 'msg-1' }]);

    const { handed_over } = await hand_over(connector);

    expect(handed_over).toEqual(['msg-1', 'msg-2']);
  });

  it('hands a message repeated on a later page over once', async () => {
    serve_round(mock_client, [{ id: 'msg-1' }], [{ id: 'msg-1' }, { id: 'msg-2' }]);

    const { handed_over } = await hand_over(connector);

    expect(handed_over).toEqual(['msg-1', 'msg-2']);
  });

  it('returns a repeated message once when no page callback is given', async () => {
    serve_round(
      mock_client,
      [{ id: 'msg-1' }, { id: 'msg-1' }],
      [{ id: 'msg-2' }, { id: 'msg-1' }],
    );

    const result = await connector.fetch_delta('t', 'u', 'f-inbox');

    expect(result.messages.map((message) => message.message_id)).toEqual(['msg-1', 'msg-2']);
  });

  it('records a repeated removal once', async () => {
    serve_round(mock_client, [gone('msg-1'), gone('msg-1')], [gone('msg-1')]);

    const { removed_ids } = await hand_over(connector);

    expect(removed_ids).toEqual(['msg-1']);
  });

  it('keeps a message removed and then added again, without recording the removal', async () => {
    serve_round(mock_client, [gone('msg-1'), { id: 'msg-2' }], [{ id: 'msg-1' }]);

    const { handed_over, removed_ids } = await hand_over(connector);

    expect(handed_over).toEqual(['msg-2', 'msg-1']);
    expect(removed_ids).toEqual([]);
  });

  it('records a message whose last event is a removal as removed', async () => {
    serve_round(mock_client, [{ id: 'msg-1' }], [gone('msg-1')], [{ id: 'msg-1' }, gone('msg-1')]);

    const { handed_over, removed_ids } = await hand_over(connector);

    expect(handed_over).toEqual(['msg-1']);
    expect(removed_ids).toEqual(['msg-1']);
  });

  it('leaves out a message removed after it was listed when no page callback is given', async () => {
    serve_round(mock_client, [{ id: 'msg-1' }, { id: 'msg-2' }], [gone('msg-1')]);

    const result = await connector.fetch_delta('t', 'u', 'f-inbox');

    expect(result.messages.map((message) => message.message_id)).toEqual(['msg-2']);
    expect(result.removed_ids).toEqual(['msg-1']);
  });
});

describe('GraphMailboxConnector - repeats across an invalid delta link fallback (issues #642, #894)', () => {
  let mock_client: MockClient;
  let connector: GraphMailboxConnector;

  beforeEach(() => {
    mock_client = create_mock_client();
    connector = create_connector(mock_client);
  });

  it('hands each message over once when both passes repeat it', async () => {
    mock_client._chain.get
      .mockResolvedValueOnce({
        value: [{ id: 'msg-1' }, { id: 'msg-1' }, gone('msg-gone')],
        '@odata.nextLink': NEXT_LINK,
      })
      .mockRejectedValueOnce(new Error('SyncStateNotFound: delta token expired'))
      .mockResolvedValueOnce({
        value: [{ id: 'msg-1' }, { id: 'msg-old' }, { id: 'msg-old' }],
        '@odata.deltaLink': FRESH_LINK,
      });

    const { handed_over, removed_ids } = await hand_over(connector, STALE_LINK);

    expect(handed_over).toEqual(['msg-1', 'msg-old']);
    expect(removed_ids).toEqual(['msg-gone']);
  });

  it('drops a removal the full re-enumeration lists as live again', async () => {
    mock_client._chain.get
      .mockResolvedValueOnce({ value: [gone('msg-back')], '@odata.nextLink': NEXT_LINK })
      .mockRejectedValueOnce(new Error('SyncStateNotFound: delta token expired'))
      .mockResolvedValueOnce({ value: [{ id: 'msg-back' }], '@odata.deltaLink': FRESH_LINK });

    const { handed_over, removed_ids } = await hand_over(connector, STALE_LINK);

    expect(handed_over).toEqual(['msg-back']);
    expect(removed_ids).toEqual([]);
  });
});
