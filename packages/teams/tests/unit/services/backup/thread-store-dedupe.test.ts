import { describe, expect, it } from 'vitest';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import { store_thread } from '@/services/backup/thread-store';
import { live, make_harness, tombstone } from './thread-store-harness';

const LATER_BACKUP_AT = '2025-02-01T00:00:00.000Z';

describe('store_thread dedupe', () => {
  it('re-uploads an unchanged live thread whose blob is missing', async () => {
    const harness = make_harness(false);
    const first = await store_thread(harness.scope, 'channel-1', live(), undefined);
    harness.put.mockClear();

    await store_thread(harness.scope, 'channel-1', live(), first);

    expect(harness.put).toHaveBeenCalledTimes(1);
    expect(harness.scope.counters.threads_deduplicated).toBe(0);
  });

  it('does not rewrite an unchanged live thread blob under --full', async () => {
    const harness = make_harness(true);
    const first = await store_thread(harness.scope, 'channel-1', live(), undefined);
    harness.put.mockClear();
    const full: BackupRunScope = { ...harness.scope, force_full: true };

    await store_thread(full, 'channel-1', live(), first);

    expect(harness.put).not.toHaveBeenCalled();
  });

  it('re-uploads a repeated tombstone whose blob is missing', async () => {
    const harness = make_harness(false);
    const first = await store_thread(harness.scope, 'channel-1', tombstone(), undefined);
    harness.put.mockClear();

    await store_thread(harness.scope, 'channel-1', tombstone(), first);

    expect(harness.put).toHaveBeenCalledTimes(1);
  });

  it('keeps a repeated tombstone unchanged and uploads nothing', async () => {
    const harness = make_harness(true);
    const first = await store_thread(harness.scope, 'channel-1', tombstone(), undefined);
    harness.put.mockClear();
    const later: BackupRunScope = { ...harness.scope, backup_at: LATER_BACKUP_AT };

    const again = await store_thread(later, 'channel-1', tombstone(), first);

    expect(again).toEqual(first);
    expect(again.backup_at).toBe(first.backup_at);
    expect(harness.put).not.toHaveBeenCalled();
    expect(harness.scope.counters.threads_deduplicated).toBe(1);
  });

  it('keeps last_live through repeated tombstones of a thread deleted from live content', async () => {
    const harness = make_harness(true);
    const live_entry = await store_thread(harness.scope, 'channel-1', live(), undefined);
    const removed = await store_thread(harness.scope, 'channel-1', tombstone(), live_entry);

    const again = await store_thread(harness.scope, 'channel-1', tombstone(), removed);

    expect(again.last_live).toEqual({
      storage_key: live_entry.storage_key,
      checksum: live_entry.checksum,
      size_bytes: live_entry.size_bytes,
    });
  });

  it('checksums the same content identically whatever order its keys arrive in', async () => {
    const harness = make_harness(true);
    const first = await store_thread(
      harness.scope,
      'channel-1',
      live([], { id: 'root-1', body: { content: 'hello' }, lastModifiedDateTime: 'x' }),
      undefined,
    );

    const reordered = await store_thread(
      harness.scope,
      'channel-1',
      live([], { lastModifiedDateTime: 'x', body: { content: 'hello' }, id: 'root-1' }),
      undefined,
    );

    expect(reordered.checksum).toBe(first.checksum);
    expect(reordered.storage_key).toBe(first.storage_key);
  });
});
