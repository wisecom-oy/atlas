/* eslint-disable @typescript-eslint/naming-convention */
import { describe, it, expect, vi } from 'vitest';
import type { Container } from 'inversify';
import { create_outlook_api } from '@/outlook-api.factory';

const OBJECT_ID = '9a1f4d2e-6b3c-4a5e-8d7f-2e3a4b5c6d7e';

/**
 * A cross-mailbox restore passed an email `targetMailbox` through unresolved, so its Outlook
 * throttle scope was the address while the same mailbox's backups were scoped to its object id.
 * A shared coordinator then kept two cooldowns for one Graph mailbox.
 */
function make_api() {
  const restore = {
    restore_snapshot: vi.fn().mockResolvedValue({ snapshot_id: 'snap-1' }),
    restore_mailbox: vi.fn().mockResolvedValue({ snapshot_id: 'mailbox' }),
  };
  const resolve_user = vi.fn(async () => ({ object_id: OBJECT_ID, email: 'jane.doe@example.com' }));
  const services: Record<string, unknown> = {
    RestoreUseCase: restore,
    UserIdentityResolver: { resolve_user },
  };
  const container = {
    get: (token: symbol) => services[token.description!] ?? {},
  } as unknown as Container;
  return { api: create_outlook_api('tenant-1', container), restore, resolve_user };
}

describe('outlook restore targetMailbox', () => {
  it('resolves an email target to its object id for a snapshot restore', async () => {
    const { api, restore } = make_api();

    await api.restore('snap-1', { targetMailbox: 'jane.doe@example.com' });

    expect(restore.restore_snapshot).toHaveBeenCalledWith(
      'tenant-1',
      'snap-1',
      expect.objectContaining({ target_mailbox: OBJECT_ID }),
    );
  });

  it('resolves an email target to its object id for a mailbox restore', async () => {
    const { api, restore } = make_api();

    await api.restoreMailbox(OBJECT_ID, { targetMailbox: 'jane.doe@example.com' });

    expect(restore.restore_mailbox).toHaveBeenCalledWith(
      'tenant-1',
      OBJECT_ID,
      expect.objectContaining({ target_mailbox: OBJECT_ID }),
    );
  });

  it('passes an object id target and an omitted target through without a lookup', async () => {
    const { api, restore, resolve_user } = make_api();

    await api.restore('snap-1', { targetMailbox: OBJECT_ID });
    await api.restore('snap-1');

    expect(restore.restore_snapshot.mock.calls[0]![2]).toMatchObject({ target_mailbox: OBJECT_ID });
    expect(restore.restore_snapshot.mock.calls[1]![2]).toBeUndefined();
    expect(resolve_user).not.toHaveBeenCalled();
  });

  it('makes no lookup for a restore that is already cancelled', async () => {
    const { api, resolve_user } = make_api();
    const controller = new AbortController();
    controller.abort();

    await api.restore('snap-1', {
      targetMailbox: 'jane.doe@example.com',
      signal: controller.signal,
    });

    expect(resolve_user).not.toHaveBeenCalled();
  });
});
