import { describe, expect, it, vi } from 'vitest';
import { create_mailbox_sync_harness, make_delta, make_message } from './mailbox-sync.fixtures';

/**
 * Issue #513. A backup read reactions once per message, and a failed read vanished into a log
 * line while the delta link moved past it. Reactions are now read once per page, and messages
 * stored without them are counted in the run summary.
 */
describe('an outlook backup capturing reactions', () => {
  it('reads reactions once for the page and reports the messages it could not read', async () => {
    const harness = create_mailbox_sync_harness();
    const fetch_reaction_properties = vi.fn(async () => new Map([['msg-1', []]]));
    Object.assign(harness.mock_connector, { fetch_reaction_properties });
    vi.mocked(harness.mock_connector.fetch_delta).mockResolvedValue(
      make_delta([make_message('msg-1', 'a'), make_message('msg-2', 'b')]),
    );

    const result = await harness.service.sync_mailbox('t', 'john.doe@example.com');

    expect(fetch_reaction_properties).toHaveBeenCalledOnce();
    expect(fetch_reaction_properties).toHaveBeenCalledWith('t', 'john.doe@example.com', [
      'msg-1',
      'msg-2',
    ]);
    expect(result.summary.stored).toBe(2);
    expect(result.summary.warnings).toEqual([
      expect.stringContaining('reactions not captured for 1 message(s)'),
    ]);
    expect(result.summary.reactions_not_captured).toBe(1);
  });

  // Issue #532: a chunk that exhausted its retries was dropped with only a log line.
  it('counts every message of a reaction read that failed outright', async () => {
    const harness = create_mailbox_sync_harness();
    const fetch_reaction_properties = vi.fn(async () => {
      throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
    });
    Object.assign(harness.mock_connector, { fetch_reaction_properties });
    vi.mocked(harness.mock_connector.fetch_delta).mockResolvedValue(
      make_delta([make_message('msg-1', 'a'), make_message('msg-2', 'b')]),
    );

    const result = await harness.service.sync_mailbox('t', 'john.doe@example.com');

    expect(result.summary.stored).toBe(2);
    expect(result.summary.reactions_not_captured).toBe(2);
  });
});
