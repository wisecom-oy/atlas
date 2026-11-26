import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedUserIdentity } from '@wisecom/atlas-types';
import {
  get_active_abort_signal,
  run_with_abort_signal,
} from '@/services/shared/graph-request-context';
import { STORED_BACKUPS_GRAPH_WAIT_MS } from '@/adapters/identity/graph-identity-lookup';
import {
  capture_warnings,
  KNOWN_ADDRESS,
  resolver_with_graph,
  STORED_JOHN,
  TENANT,
} from './identity-fallback-rig';

/**
 * Issue #887: `verify`, `list -m` and `stats -m` given an address waited out the whole Graph retry
 * budget, about 24 minutes, before using the identity registry they had already loaded.
 */
const CURRENT_JOHN: ResolvedUserIdentity = { ...STORED_JOHN, object_id: 'oid-current-john' };

/** A Graph lookup that never answers on its own and rejects when the run's signal fires. */
function graph_that_hangs(): () => Promise<ResolvedUserIdentity> {
  return () => {
    const signal = get_active_abort_signal();
    return new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
    });
  };
}

/** Starts a lookup and reports whether it settled after `ms` of simulated time. */
async function settled_after(pending: Promise<unknown>, ms: number): Promise<boolean> {
  let settled = false;
  void pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  await vi.advanceTimersByTimeAsync(ms);
  return settled;
}

describe('CachingIdentityResolver, bounded Graph wait for stored backups', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('answers from the registry once the wait elapses, and stops the Graph lookup', async () => {
    vi.useFakeTimers();
    const warnings = capture_warnings();
    const signals: (AbortSignal | undefined)[] = [];
    const hang = graph_that_hangs();
    const resolver = resolver_with_graph(() => (signals.push(get_active_abort_signal()), hang()));

    const pending = resolver.resolve_user(TENANT, KNOWN_ADDRESS, { purpose: 'stored_backups' });

    expect(await settled_after(pending, STORED_BACKUPS_GRAPH_WAIT_MS - 1)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual(STORED_JOHN);
    expect(signals[0]?.aborted).toBe(true);
    expect(warnings.join('\n')).toContain('did not answer within 15 s');
  });

  it('answers from the registry even when the lookup ignores its signal', async () => {
    vi.useFakeTimers();
    capture_warnings();
    const resolver = resolver_with_graph(() => new Promise<never>(() => undefined));

    const pending = resolver.resolve_user(TENANT, KNOWN_ADDRESS, { purpose: 'stored_backups' });
    await vi.advanceTimersByTimeAsync(STORED_BACKUPS_GRAPH_WAIT_MS);

    await expect(pending).resolves.toEqual(STORED_JOHN);
  });

  it("uses Graph's answer when it comes within the wait, so a recycled address still moves", async () => {
    const resolver = resolver_with_graph(() => Promise.resolve(CURRENT_JOHN));

    await expect(
      resolver.resolve_user(TENANT, KNOWN_ADDRESS, { purpose: 'stored_backups' }),
    ).resolves.toEqual(CURRENT_JOHN);
  });

  it('waits on Graph without a bound for an address the registry does not know', async () => {
    vi.useFakeTimers();
    const { promise, resolve } = Promise.withResolvers<ResolvedUserIdentity>();
    const jane = { object_id: 'oid-jane', display_name: 'Jane Roe', email: 'jane.roe@example.com' };
    const resolver = resolver_with_graph(() => promise);

    const pending = resolver.resolve_user(TENANT, jane.email, { purpose: 'stored_backups' });

    expect(await settled_after(pending, STORED_BACKUPS_GRAPH_WAIT_MS * 4)).toBe(false);
    resolve(jane);
    await expect(pending).resolves.toEqual(jane);
  });

  it('waits on Graph without a bound for a command that works on live data', async () => {
    vi.useFakeTimers();
    const { promise, resolve } = Promise.withResolvers<ResolvedUserIdentity>();
    const resolver = resolver_with_graph(() => promise);

    const pending = resolver.resolve_user(TENANT, KNOWN_ADDRESS);

    expect(await settled_after(pending, STORED_BACKUPS_GRAPH_WAIT_MS * 4)).toBe(false);
    resolve(CURRENT_JOHN);
    await expect(pending).resolves.toEqual(CURRENT_JOHN);
  });

  it.each(['microsoft_365', 'stored_backups'] as const)(
    'rethrows a Ctrl+C during a %s lookup instead of using the registry',
    async (purpose) => {
      const controller = new AbortController();
      const stop = new Error('Run interrupted by Ctrl+C');
      const resolver = resolver_with_graph(graph_that_hangs());

      const pending = run_with_abort_signal(controller.signal, () =>
        resolver.resolve_user(TENANT, KNOWN_ADDRESS, { purpose }),
      );
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      controller.abort(stop);

      await expect(pending).rejects.toBe(stop);
    },
  );
});
