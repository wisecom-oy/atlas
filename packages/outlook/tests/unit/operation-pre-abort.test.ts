import { describe, expect, it, vi } from 'vitest';
import type { TenantContextFactory } from '@wisecom/atlas-types';
import { MailboxSyncService } from '@/services/backup/mailbox-sync.service';
import { RestoreService } from '@/services/restore/restore.service';
import { SaveService } from '@/services/save/save.service';

describe('Outlook operation cancellation', () => {
  it('does no remote work when every operation starts interrupted', async () => {
    const factory = { create: vi.fn() } as unknown as TenantContextFactory;
    const callbacks = Array.from({ length: 5 }, () => vi.fn());
    const should_interrupt = (): boolean => true;
    const backup = new MailboxSyncService(factory, {} as never, {} as never);
    const restore = new RestoreService(factory, {} as never, {} as never, {} as never);
    const save = new SaveService(factory, {} as never, {} as never);

    const results = await Promise.all([
      backup.sync_mailbox('tenant-1', 'owner-1', {
        should_interrupt,
        on_progress: callbacks[0],
      }),
      restore.restore_snapshot('tenant-1', 'snap-1', {
        should_interrupt,
        on_progress: callbacks[1],
      }),
      restore.restore_mailbox('tenant-1', 'owner-1', {
        should_interrupt,
        on_progress: callbacks[2],
      }),
      save.save_snapshot('tenant-1', 'snap-1', {
        should_interrupt,
        on_progress: callbacks[3],
      }),
      save.save_mailbox('tenant-1', 'owner-1', {
        should_interrupt,
        on_progress: callbacks[4],
      }),
    ]);

    expect(factory.create).not.toHaveBeenCalled();
    expect(results.every((result) => result.interrupted)).toBe(true);
    for (const callback of callbacks) {
      expect(callback.mock.calls.map(([event]) => event.phase)).toEqual([
        'discovering',
        'finalizing',
        'interrupted',
      ]);
    }
  });
});
