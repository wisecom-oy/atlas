/**
 * Failures are the most expensive runs a tenant pays for, so the cost burned
 * before a rejection has to survive it: a scheduler that reads cost only on
 * success re-queues straight into a tenant that is already throttled.
 */

import { describe, it, expect } from 'vitest';
import {
  run_with_cost_tracking,
  get_active_counter,
  get_graph_cost,
} from '@/services/shared/graph-request-context';

/** Stand-in for a Graph 429: a real error type, so `instanceof` is testable. */
class ThrottledError extends Error {}

/** Records `count` Graph requests, then fails the way a throttled run does. */
async function burn_then_fail(
  count: number,
  err: unknown = new ThrottledError('429'),
): Promise<never> {
  for (let i = 0; i < count; i++) get_active_counter()?.record('outlook', 'delta_sync');
  throw err;
}

describe('graph cost on the rejection path', () => {
  it('reports the requests burned before the failure', async () => {
    const err = await run_with_cost_tracking(() => burn_then_fail(3)).catch((e: unknown) => e);

    const cost = get_graph_cost(err);
    expect(cost?.requests_total).toBe(3);
    expect(cost?.by_service.outlook?.requests).toBe(3);
    expect(cost?.requests_by_type['delta_sync']).toBe(3);
  });

  it('rethrows the original error untouched, so instanceof still works', async () => {
    // Graph errors carry their own fields; the caller's checks must survive.
    const thrown = Object.assign(new ThrottledError('Too Many Requests'), { statusCode: 429 });

    const caught = await run_with_cost_tracking(() => burn_then_fail(1, thrown)).catch(
      (e: unknown) => e,
    );

    expect(caught).toBe(thrown);
    expect(caught).toBeInstanceOf(ThrottledError);
    expect(thrown.statusCode).toBe(429);
    expect(thrown.message).toBe('Too Many Requests');
  });

  it('keeps the cost off enumerable output so error logging is unchanged', async () => {
    const err = (await run_with_cost_tracking(() => burn_then_fail(2)).catch(
      (e: unknown) => e,
    )) as Error;

    expect(Object.keys(err)).not.toContain('graph_cost');
    expect(JSON.stringify({ ...err })).not.toContain('requests_total');
    // Still readable through the accessor.
    expect(get_graph_cost(err)?.requests_total).toBe(2);
  });

  it('records a zero-cost snapshot when the operation failed before any request', async () => {
    const err = await run_with_cost_tracking(async () => {
      throw new Error('config rejected before any Graph call');
    }).catch((e: unknown) => e);

    // Zero is a fact worth reporting: it says the failure cost the tenant nothing.
    expect(get_graph_cost(err)?.requests_total).toBe(0);
  });

  it('still returns cost through the tuple when the operation succeeds', async () => {
    const [result, cost] = await run_with_cost_tracking(async () => {
      get_active_counter()?.record('outlook', 'fetch_message');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(cost.requests_total).toBe(1);
  });

  it('reports the outermost call cost when contexts nest', async () => {
    const err = await run_with_cost_tracking(async () => {
      get_active_counter()?.record('outlook', 'list_folders');
      await run_with_cost_tracking(() => burn_then_fail(2));
    }).catch((e: unknown) => e);

    // The caller ran the outer operation; that is the cost they are billed for.
    expect(get_graph_cost(err)?.requests_total).toBe(1);
    expect(get_graph_cost(err)?.requests_by_type['list_folders']).toBe(1);
  });

  it('survives an error that cannot carry the cost, rather than masking it', async () => {
    const frozen = Object.freeze(new Error('frozen'));

    const caught = await run_with_cost_tracking(() => burn_then_fail(1, frozen)).catch(
      (e: unknown) => e,
    );

    expect(caught).toBe(frozen);
    expect(get_graph_cost(caught)).toBeUndefined();
  });

  it('survives a thrown primitive', async () => {
    const caught = await run_with_cost_tracking(() => burn_then_fail(1, 'boom')).catch(
      (e: unknown) => e,
    );

    expect(caught).toBe('boom');
    expect(get_graph_cost(caught)).toBeUndefined();
  });
});

describe('get_graph_cost', () => {
  it('returns undefined for errors that never went through a tracked operation', () => {
    expect(get_graph_cost(new Error('unrelated'))).toBeUndefined();
    expect(get_graph_cost(undefined)).toBeUndefined();
    expect(get_graph_cost(null)).toBeUndefined();
    expect(get_graph_cost('string')).toBeUndefined();
    expect(get_graph_cost(42)).toBeUndefined();
  });

  it('rejects a graph_cost that is not an OperationCost', () => {
    expect(
      get_graph_cost(Object.assign(new Error('x'), { graph_cost: 'not-a-cost' })),
    ).toBeUndefined();
  });
});
