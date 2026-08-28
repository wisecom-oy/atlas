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
