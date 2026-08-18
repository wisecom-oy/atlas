/**
 * The counting half of cost tracking. The middleware sits immediately before
 * the SDK's HTTP handler, so it is invoked once per request actually sent --
 * which is what makes paginated and retried calls count for what they cost.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Context, Middleware } from '@microsoft/microsoft-graph-client';
import { GraphCostMiddleware } from '@/graph-cost-middleware';
import {
  get_graph_cost,
  run_with_cost_tracking,
  run_with_graph_operation,
} from '@wisecom/atlas-core/services/shared/graph-request-context';

/** Terminal handler standing in for HTTPMessageHandler. */
function make_transport(): Middleware & { calls: number } {
  return {
    calls: 0,
    async execute(this: { calls: number }) {
      this.calls++;
    },
  } as Middleware & { calls: number };
}

function make_chain(): {
  middleware: GraphCostMiddleware;
  transport: Middleware & { calls: number };
} {
  const middleware = new GraphCostMiddleware();
  const transport = make_transport();
  middleware.setNext(transport);
  return { middleware, transport };
}

function context_for(url: string, options?: Context['options']): Context {
  return { request: url, options } as Context;
}

const DELTA_URL = 'https://graph.microsoft.com/v1.0/users/u/mailFolders/f/messages/delta';

describe('GraphCostMiddleware', () => {
  it('counts every request of a paginated call, not the call', async () => {
    const { middleware } = make_chain();

    const [, cost] = await run_with_cost_tracking(() =>
      run_with_graph_operation({ pool: 'outlook', request_type: 'delta_sync' }, async () => {
        // One connector call, four continuation pages.
        for (let page = 0; page < 4; page++) await middleware.execute(context_for(DELTA_URL));
      }),
    );

    expect(cost.requests_total).toBe(4);
    expect(cost.requests_by_type['delta_sync']).toBe(4);
    expect(cost.by_service.outlook?.requests).toBe(4);
  });

  it('counts every retried attempt of a single request', async () => {
    const { middleware } = make_chain();

    const [, cost] = await run_with_cost_tracking(() =>
      run_with_graph_operation({ pool: 'outlook', request_type: 'fetch_message' }, async () => {
        // A throttled request re-executes the chain below the retry handler.
        for (let attempt = 0; attempt < 3; attempt++) {
          await middleware.execute(
            context_for('https://graph.microsoft.com/v1.0/users/u/messages/1'),
          );
        }
      }),
    );

    expect(cost.requests_total).toBe(3);
    expect(cost.by_service.outlook?.requests).toBe(3);
  });

  it('charges the declared resource units per request, not per call', async () => {
    const { middleware } = make_chain();

    const [, cost] = await run_with_cost_tracking(() =>
      run_with_graph_operation(
        { pool: 'identity', request_type: 'list_users', resource_units: 2 },
        async () => {
          await middleware.execute(context_for('https://graph.microsoft.com/v1.0/users'));
          await middleware.execute(context_for('https://graph.microsoft.com/v1.0/users?$skip=1'));
        },
      ),
    );

    expect(cost.by_service.identity?.requests).toBe(2);
    expect(cost.by_service.identity?.resource_units).toBe(4);
  });

  it('measures upload bytes from the request body', async () => {
    const { middleware } = make_chain();
    const chunk = Buffer.alloc(1024);

    const [, cost] = await run_with_cost_tracking(() =>
      run_with_graph_operation({ pool: 'outlook', request_type: 'upload_chunk' }, async () => {
        // A retried chunk is sent twice and charged twice against the window.
        await middleware.execute(
          context_for('https://graph.microsoft.com/upload', { body: chunk }),
        );
        await middleware.execute(
          context_for('https://graph.microsoft.com/upload', { body: chunk }),
        );
      }),
    );

    expect(cost.by_service.outlook?.upload_bytes).toBe(2048);
  });

  it('counts a string body by its encoded length', async () => {
    const { middleware } = make_chain();

    const [, cost] = await run_with_cost_tracking(() =>
      run_with_graph_operation({ pool: 'outlook', request_type: 'create_message' }, () =>
        middleware.execute(
          context_for('https://graph.microsoft.com/v1.0/users/u/messages', {
            body: '{"subject":"hyvää"}',
          }),
        ),
      ),
    );

    expect(cost.by_service.outlook?.upload_bytes).toBe(Buffer.byteLength('{"subject":"hyvää"}'));
  });

  it('always continues the chain, counter or not', async () => {
    const { middleware, transport } = make_chain();

    await run_with_cost_tracking(() => middleware.execute(context_for(DELTA_URL)));
    await middleware.execute(context_for(DELTA_URL)); // no cost context (CLI run)

    expect(transport.calls).toBe(2);
  });

  it('records nothing outside an SDK cost context', async () => {
    const { middleware } = make_chain();
    // A CLI run has no counter; the middleware must stay silent, not throw.
    await expect(middleware.execute(context_for(DELTA_URL))).resolves.toBeUndefined();
  });

  it.each([
    ['https://graph.microsoft.com/v1.0/users/u/mailFolders', 'outlook'],
    ['https://graph.microsoft.com/v1.0/users/u/messages/1/attachments', 'outlook'],
    ['https://graph.microsoft.com/v1.0/users/u/mailboxSettings', 'outlook'],
    ['https://graph.microsoft.com/v1.0/sites/s/drives', 'sharepoint_onedrive'],
    ['https://graph.microsoft.com/v1.0/drives/d/root/delta', 'sharepoint_onedrive'],
    ['https://graph.microsoft.com/v1.0/users/u/drive/root/delta', 'sharepoint_onedrive'],
    ['https://graph.microsoft.com/v1.0/users', 'identity'],
  ])('attributes an unlabelled %s to the %s pool', async (url, pool) => {
    const { middleware } = make_chain();

    const [, cost] = await run_with_cost_tracking(() => middleware.execute(context_for(url)));

    expect(cost.by_service[pool as 'outlook']?.requests).toBe(1);
    expect(cost.requests_by_type['unlabelled']).toBe(1);
  });

  it('reads the url from a Request object as well as a string', async () => {
    const { middleware } = make_chain();
    const request = { url: 'https://graph.microsoft.com/v1.0/sites/s/drives' } as Request;

    const [, cost] = await run_with_cost_tracking(() => middleware.execute({ request } as Context));

    expect(cost.by_service.sharepoint_onedrive?.requests).toBe(1);
  });

  it('lets an inner operation label its own requests', async () => {
    const { middleware } = make_chain();

    const [, cost] = await run_with_cost_tracking(() =>
      run_with_graph_operation({ pool: 'outlook', request_type: 'outer' }, async () => {
        await middleware.execute(context_for(DELTA_URL));
        await run_with_graph_operation({ pool: 'outlook', request_type: 'inner' }, () =>
          middleware.execute(context_for(DELTA_URL)),
        );
        await middleware.execute(context_for(DELTA_URL));
      }),
    );

    expect(cost.requests_by_type).toEqual({ outer: 2, inner: 1 });
  });

  it('counts a request that fails downstream: the tenant was still charged', async () => {
    const middleware = new GraphCostMiddleware();
    middleware.setNext({
      execute: vi.fn().mockRejectedValue(new Error('429 Too Many Requests')),
    } as unknown as Middleware);

    const err = await run_with_cost_tracking(() =>
      run_with_graph_operation({ pool: 'outlook', request_type: 'delta_sync' }, () =>
        middleware.execute(context_for(DELTA_URL)),
      ),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(get_graph_cost(err)?.requests_total).toBe(1);
  });
});
