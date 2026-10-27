/* eslint-disable @typescript-eslint/naming-convention */
import { describe, it, expect, vi } from 'vitest';
import type { Container } from 'inversify';
import { get_active_counter } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { create_outlook_api } from '@/outlook-api.factory';

/**
 * Issue #517. `saveMailbox` resolved the address before entering the cost-tracked scope and
 * returned no `graphCost`, so the `GET /users/{address}` lookup was invisible to a scheduler.
 */
function make_api() {
  const save = {
    save_snapshot: vi.fn().mockResolvedValue({ snapshot_id: 'snap-1' }),
    save_mailbox: vi.fn().mockResolvedValue({ snapshot_id: 'mailbox' }),
  };
  const resolve_user = vi.fn(async () => {
    get_active_counter()?.record('identity', 'resolve_user');
    return { object_id: '9a1f4d2e-6b3c-4a5e-8d7f-2e3a4b5c6d7e', email: 'john.doe@example.com' };
  });
  const services: Record<string, unknown> = {
    SaveUseCase: save,
    UserIdentityResolver: { resolve_user },
  };
  const container = {
    get: (token: symbol) => services[token.description!] ?? {},
  } as unknown as Container;
  return { api: create_outlook_api('tenant-1', container), save };
}

describe('outlook save graphCost', () => {
  it('saveMailbox counts the address lookup', async () => {
    const { api, save } = make_api();

    const result = await api.saveMailbox('john.doe@example.com');

    expect(save.save_mailbox).toHaveBeenCalledWith(
      'tenant-1',
      '9a1f4d2e-6b3c-4a5e-8d7f-2e3a4b5c6d7e',
      undefined,
    );
    expect(result.graphCost?.requestsTotal).toBe(1);
    expect(result.graphCost?.requestsByType).toEqual({ resolve_user: 1 });
  });

  it('save returns graphCost too, as restore does', async () => {
    const { api } = make_api();

    const result = await api.save('snap-1');

    expect(result.graphCost?.requestsTotal).toBe(0);
  });
});
