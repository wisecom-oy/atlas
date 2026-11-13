import { describe, it, expect, vi } from 'vitest';
import type { Container } from 'inversify';
import { NotFoundError } from '@wisecom/atlas-types';
import { create_outlook_api } from '@/outlook-api.factory';

/**
 * Issue #735: `restore` and `save` with a `messageRef` that names no message reject with
 * NotFoundError (`ATLAS_NOT_FOUND`), the same error a folder or file selector that matches
 * nothing raises. The service raises it before any restore folder or archive exists; the SDK
 * must hand that rejection to the caller unchanged.
 */
const MAILBOX = 'jane.doe@example.com';

function make_api() {
  const not_found = (): Promise<never> =>
    Promise.reject(new NotFoundError('No message matches "99" in snapshot snap-1'));
  const restore = { restore_mailbox: vi.fn(), restore_snapshot: vi.fn(not_found) };
  const save = { save_mailbox: vi.fn(), save_snapshot: vi.fn(not_found) };
  const resolve_user = vi.fn(async () => ({ object_id: 'owner-1', email: MAILBOX }));
  const services: Record<string, unknown> = {
    RestoreUseCase: restore,
    SaveUseCase: save,
    UserIdentityResolver: { resolve_user },
  };
  const container = {
    get: (token: symbol) => services[token.description!] ?? {},
  } as unknown as Container;
  return { api: create_outlook_api('tenant-1', container), restore, save };
}

describe('outlook snapshot methods with a messageRef that names no message (#735)', () => {
  it('restore rejects with NotFoundError and passes the reference to the service', async () => {
    const { api, restore } = make_api();

    const run = api.restore('snap-1', { messageRef: '99' });

    await expect(run).rejects.toBeInstanceOf(NotFoundError);
    expect(restore.restore_snapshot).toHaveBeenCalledWith(
      'tenant-1',
      'snap-1',
      expect.objectContaining({ message_ref: '99' }),
    );
  });

  it('save rejects with NotFoundError and passes the reference to the service', async () => {
    const { api, save } = make_api();

    const run = api.save('snap-1', { messageRef: 'AAMkAG-no-such-id' });

    await expect(run).rejects.toBeInstanceOf(NotFoundError);
    expect(save.save_snapshot).toHaveBeenCalledWith(
      'tenant-1',
      'snap-1',
      expect.objectContaining({ message_ref: 'AAMkAG-no-such-id' }),
    );
  });
});
