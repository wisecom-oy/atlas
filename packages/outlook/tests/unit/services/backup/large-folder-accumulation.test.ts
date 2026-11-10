import { describe, expect, it, vi } from 'vitest';
import type { Manifest } from '@wisecom/atlas-types';
import { create_mailbox_sync_harness } from './mailbox-sync.fixtures';

/**
 * Issue #626. The run accumulated each folder's results with `push(...outcome.removed_ids)`, which
 * passes every id as a call argument and throws `RangeError` past V8's argument limit (about 125k
 * on Node 22). A folder that large failed the mailbox after it had been fully enumerated.
 */
const BEYOND_ARGUMENT_LIMIT = 300_000;

describe('an outlook backup of a folder larger than the engine argument limit', () => {
  it('records every removed id instead of throwing', async () => {
    const harness = create_mailbox_sync_harness();
    vi.mocked(harness.mock_manifests.find_latest_by_owner).mockResolvedValue({
      snapshot_id: 'snap-head',
      total_objects: 0,
      delta_links: {},
      id_format: 'immutable',
      entries: [],
    } as unknown as Manifest);
    const removed_ids = Array.from({ length: BEYOND_ARGUMENT_LIMIT }, (_, i) => `msg-${i}`);
    vi.mocked(harness.mock_connector.fetch_delta).mockResolvedValue({
      messages: [],
      removed_ids,
      delta_link: 'https://delta/new',
      delta_reset: false,
    });

    await harness.service.sync_mailbox('t', 'user@example.com');

    const saved = vi.mocked(harness.mock_manifests.save).mock.calls.at(-1)![1];
    expect(saved.removed_object_ids).toHaveLength(BEYOND_ARGUMENT_LIMIT);
  });
});
