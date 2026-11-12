/* eslint-disable @typescript-eslint/naming-convention */
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import type { Container } from 'inversify';
import { ConfigError } from '@wisecom/atlas-types';
import { create_outlook_api } from '@/outlook-api.factory';

/**
 * Issue #705: `restoreMailbox` and `saveMailbox` with `messageRef` processed the whole mailbox.
 * The SDK refuses it before the mailbox email is resolved through Graph, not only in the service.
 */
const MAILBOX = 'jane.doe@example.com';

function make_api() {
  const restore = { restore_mailbox: vi.fn() };
  const save = { save_mailbox: vi.fn() };
  const resolve_user = vi.fn(async () => ({ object_id: 'owner-1', email: MAILBOX }));
  const services: Record<string, unknown> = {
    RestoreUseCase: restore,
    SaveUseCase: save,
    UserIdentityResolver: { resolve_user },
  };
  const container = {
    get: (token: symbol) => services[token.description!] ?? {},
  } as unknown as Container;
  return { api: create_outlook_api('tenant-1', container), restore, save, resolve_user };
}

describe('outlook mailbox methods with messageRef', () => {
  it.each(['1', ''])(
    'restoreMailbox rejects messageRef %j before resolving the mailbox',
    async (message_ref) => {
      const { api, restore, resolve_user } = make_api();

      await expect(api.restoreMailbox(MAILBOX, { messageRef: message_ref })).rejects.toThrow(
        ConfigError,
      );

      expect(resolve_user).not.toHaveBeenCalled();
      expect(restore.restore_mailbox).not.toHaveBeenCalled();
    },
  );

  it.each(['1', ''])(
    'saveMailbox rejects messageRef %j before resolving the mailbox and destroys the stream',
    async (message_ref) => {
      const { api, save, resolve_user } = make_api();
      const sink = new PassThrough();

      await expect(
        api.saveMailbox(MAILBOX, { messageRef: message_ref, output: sink }),
      ).rejects.toThrow(ConfigError);

      expect(resolve_user).not.toHaveBeenCalled();
      expect(save.save_mailbox).not.toHaveBeenCalled();
      expect(sink.destroyed).toBe(true);
    },
  );
});
