import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@microsoft/microsoft-graph-client';
import { GraphUserIdentityResolver } from '@/graph-user-identity-resolver.adapter';

/**
 * Issue #202: `resolve_by_object_id` wrapped its Graph call in `catch { return undefined }`, so a
 * deleted user, a 503 and a dropped socket produced the same answer with nothing logged. A caller
 * had no way to tell bad input from an outage, and identity attribution degraded to nothing while
 * looking exactly like a typo.
 */
const OBJECT_ID = '00000000-0000-0000-0000-000000000000';

function graph_error(status: number, code?: string): Record<string, unknown> {
  return { statusCode: status, code, message: `HTTP ${status}` };
}

/** Graph client stub whose `get()` resolves or rejects with whatever the test supplies. */
function make_client(get: () => Promise<unknown>): Client {
  return {
    api: () => ({ select: () => ({ get }) }),
  } as unknown as Client;
}

describe('GraphUserIdentityResolver.resolve_by_object_id', () => {
  it('returns the identity when Graph knows the object', async () => {
    const client = make_client(() =>
      Promise.resolve({
        id: OBJECT_ID,
        displayName: 'John Doe',
        mail: 'john.doe@example.com',
        userPrincipalName: 'john.doe@example.com',
      }),
    );

    const identity = await new GraphUserIdentityResolver(client).resolve_by_object_id(
      't',
      OBJECT_ID,
    );

    expect(identity).toEqual({
      object_id: OBJECT_ID,
      display_name: 'John Doe',
      email: 'john.doe@example.com',
    });
  });

  it('returns undefined on a genuine 404', async () => {
    const client = make_client(() => Promise.reject(graph_error(404, 'Request_ResourceNotFound')));

    await expect(
      new GraphUserIdentityResolver(client).resolve_by_object_id('t', OBJECT_ID),
    ).resolves.toBeUndefined();
  });

  // The id names the storage prefix, so a response without one must not become an identity.
  it.each([{}, { id: '' }, { id: 42 }, null])(
    'rejects a user payload without a usable id: %j',
    async (payload) => {
      const client = make_client(() => Promise.resolve(payload));

      await expect(
        new GraphUserIdentityResolver(client).resolve_by_object_id('t', OBJECT_ID),
      ).rejects.toThrow('Graph user response has no id');
    },
  );

  it.each([500, 502, 503, 504, 429])('rethrows a transient %i', async (status) => {
    const client = make_client(() => Promise.reject(graph_error(status)));

    await expect(
      new GraphUserIdentityResolver(client).resolve_by_object_id('t', OBJECT_ID),
    ).rejects.toMatchObject({ statusCode: status });
  });

  it('rethrows a network failure', async () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const client = make_client(() => Promise.reject(err));

    await expect(
      new GraphUserIdentityResolver(client).resolve_by_object_id('t', OBJECT_ID),
    ).rejects.toThrow('socket hang up');
  });

  it('rethrows a 403, since a missing grant is not a missing user', async () => {
    // Swallowing this degraded every identity lookup in the tenant to a silent nothing.
    const client = make_client(() =>
      Promise.reject(graph_error(403, 'Authorization_RequestDenied')),
    );

    await expect(
      new GraphUserIdentityResolver(client).resolve_by_object_id('t', OBJECT_ID),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('logs the object id when it swallows a 404', async () => {
    // logger.debug is gated behind DEBUG, matching how the rest of the repo reports benign
    // degradation, so the test opts in rather than the code shouting on every deleted user.
    vi.stubEnv('DEBUG', '1');
    const lines: string[] = [];
    vi.spyOn(console, 'debug').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(' '));
    });
    const client = make_client(() => Promise.reject(graph_error(404)));

    await new GraphUserIdentityResolver(client).resolve_by_object_id('t', OBJECT_ID);

    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    expect(lines.join('\n')).toContain(OBJECT_ID);
  });
});

/** A primary SMTP address that is not the UPN 404s on `/users/{key}`; it resolves through `mail`. */
describe('GraphUserIdentityResolver.resolve_user', () => {
  const USER = { id: OBJECT_ID, displayName: 'John Doe', mail: 'john.doe@example.com' };

  function client_with(
    by_upn: () => Promise<unknown>,
    by_mail: () => Promise<unknown>,
  ): { client: Client; filters: string[] } {
    const filters: string[] = [];
    const client = {
      api: (path: string) =>
        path === '/users'
          ? { filter: (f: string) => (filters.push(f), { select: () => ({ get: by_mail }) }) }
          : { select: () => ({ get: by_upn }) },
    } as unknown as Client;
    return { client, filters };
  }

  it('falls back to a mail filter when the address is not a UPN', async () => {
    const { client, filters } = client_with(
      () => Promise.reject(graph_error(404, 'Request_ResourceNotFound')),
      () => Promise.resolve({ value: [USER] }),
    );

    const identity = await new GraphUserIdentityResolver(client).resolve_user(
      't',
      "John.O'Doe@Example.com",
    );

    expect(filters).toEqual(["mail eq 'john.o''doe@example.com'"]);
    expect(identity.object_id).toBe(OBJECT_ID);
  });

  it('rethrows the original 404 when no user has that mail either', async () => {
    const not_found = graph_error(404, 'Request_ResourceNotFound');
    const { client } = client_with(
      () => Promise.reject(not_found),
      () => Promise.resolve({ value: [] }),
    );

    await expect(
      new GraphUserIdentityResolver(client).resolve_user('t', 'nobody@example.com'),
    ).rejects.toBe(not_found);
  });

  it('rejects a malformed mail filter page instead of reading it as no match', async () => {
    const { client } = client_with(
      () => Promise.reject(graph_error(404, 'Request_ResourceNotFound')),
      () => Promise.resolve({ value: USER }),
    );

    await expect(
      new GraphUserIdentityResolver(client).resolve_user('t', 'john.doe@example.com'),
    ).rejects.toThrow('Graph /users response has a non-array value');
  });

  it('does not mask a 403 behind the mail fallback', async () => {
    const by_mail = vi.fn();
    const { client } = client_with(() => Promise.reject(graph_error(403)), by_mail);

    await expect(
      new GraphUserIdentityResolver(client).resolve_user('t', 'john.doe@example.com'),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(by_mail).not.toHaveBeenCalled();
  });
});
