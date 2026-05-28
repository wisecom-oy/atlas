import { describe, it, expect } from 'vitest';
import { GraphRequestCounter } from '@/services/shared/graph-request-counter';
import {
  run_with_cost_tracking,
  get_active_counter,
} from '@/services/shared/graph-request-context';

describe('GraphRequestCounter', () => {
  it('starts empty', () => {
    const counter = new GraphRequestCounter();
    const cost = counter.snapshot();
    expect(cost.requests_total).toBe(0);
    expect(cost.by_service).toEqual({});
    expect(cost.requests_by_type).toEqual({});
  });

  it('records a single outlook request', () => {
    const counter = new GraphRequestCounter();
    counter.record('outlook', 'delta_sync');
    const cost = counter.snapshot();
    expect(cost.requests_total).toBe(1);
    expect(cost.by_service.outlook).toEqual({ requests: 1, resource_units: 1, upload_bytes: 0 });
    expect(cost.requests_by_type['delta_sync']).toBe(1);
    expect(cost.by_service.identity).toBeUndefined();
  });

  it('records requests to multiple pools independently', () => {
    const counter = new GraphRequestCounter();
    counter.record('outlook', 'list_folders');
    counter.record('outlook', 'delta_sync');
    counter.record('identity', 'mailbox_exists', { resource_units: 1 });
    counter.record('identity', 'list_users', { resource_units: 2 });

    const cost = counter.snapshot();
    expect(cost.requests_total).toBe(4);
    expect(cost.by_service.outlook?.requests).toBe(2);
    expect(cost.by_service.outlook?.resource_units).toBe(2);
    expect(cost.by_service.identity?.requests).toBe(2);
    expect(cost.by_service.identity?.resource_units).toBe(3);
    expect(cost.by_service.sharepoint_onedrive).toBeUndefined();
  });

  it('accumulates resource_units for varying costs', () => {
    const counter = new GraphRequestCounter();
    counter.record('sharepoint_onedrive', 'delta_drive', { resource_units: 1 });
    counter.record('sharepoint_onedrive', 'list_drive_items', { resource_units: 2 });
    counter.record('sharepoint_onedrive', 'get_permissions', { resource_units: 5 });

    const cost = counter.snapshot();
    expect(cost.by_service.sharepoint_onedrive?.requests).toBe(3);
    expect(cost.by_service.sharepoint_onedrive?.resource_units).toBe(8);
  });

  it('tracks upload_bytes per pool', () => {
    const counter = new GraphRequestCounter();
    counter.record('outlook', 'upload_chunk', { upload_bytes: 1024 });
    counter.record('outlook', 'upload_chunk', { upload_bytes: 2048 });
    expect(counter.snapshot().by_service.outlook?.upload_bytes).toBe(3072);
  });

  it('snapshot does not reset the counter', () => {
    const counter = new GraphRequestCounter();
    counter.record('outlook', 'delta_sync');
    const first = counter.snapshot();
    counter.record('outlook', 'fetch_attachments');
    const second = counter.snapshot();
    expect(first.requests_total).toBe(1);
    expect(second.requests_total).toBe(2);
  });

  it('elapsed_ms is non-negative', () => {
    const counter = new GraphRequestCounter();
    expect(counter.snapshot().elapsed_ms).toBeGreaterThanOrEqual(0);
  });
});

describe('run_with_cost_tracking and get_active_counter', () => {
  it('get_active_counter is undefined outside a context', () => {
    expect(get_active_counter()).toBeUndefined();
  });

  it('run_with_cost_tracking returns [result, cost]', async () => {
    const [result, cost] = await run_with_cost_tracking(async () => 'hello');
    expect(result).toBe('hello');
    expect(cost.requests_total).toBe(0);
    expect(typeof cost.elapsed_ms).toBe('number');
  });

  it('get_active_counter is defined inside the context', async () => {
    await run_with_cost_tracking(async () => {
      expect(get_active_counter()).toBeDefined();
    });
  });

  it('requests recorded inside fn appear in the returned cost', async () => {
    const [, cost] = await run_with_cost_tracking(async () => {
      get_active_counter()?.record('outlook', 'delta_sync');
      get_active_counter()?.record('outlook', 'fetch_attachments');
      get_active_counter()?.record('identity', 'mailbox_exists', { resource_units: 1 });
    });

    expect(cost.requests_total).toBe(3);
    expect(cost.by_service.outlook?.requests).toBe(2);
    expect(cost.by_service.identity?.requests).toBe(1);
  });

  it('get_active_counter is undefined after the context closes', async () => {
    await run_with_cost_tracking(async () => {});
    expect(get_active_counter()).toBeUndefined();
  });

  it('nested calls get isolated counters', async () => {
    const [, outer] = await run_with_cost_tracking(async () => {
      get_active_counter()?.record('outlook', 'list_folders');

      const [, inner] = await run_with_cost_tracking(async () => {
        get_active_counter()?.record('outlook', 'delta_sync');
        get_active_counter()?.record('outlook', 'delta_sync');
      });

      expect(inner.requests_total).toBe(2);
    });

    expect(outer.requests_total).toBe(1);
    expect(outer.requests_by_type['list_folders']).toBe(1);
    expect(outer.requests_by_type['delta_sync']).toBeUndefined();
  });

  it('concurrent calls do not share counters', async () => {
    const [costA, costB] = await Promise.all([
      run_with_cost_tracking(async () => {
        await new Promise<void>((r) => setTimeout(r, 10));
        get_active_counter()?.record('outlook', 'delta_sync');
      }).then(([, c]) => c),

      run_with_cost_tracking(async () => {
        get_active_counter()?.record('outlook', 'fetch_attachments');
        get_active_counter()?.record('outlook', 'fetch_attachments');
      }).then(([, c]) => c),
    ]);

    expect(costA.requests_by_type['delta_sync']).toBe(1);
    expect(costA.requests_by_type['fetch_attachments']).toBeUndefined();
    expect(costB.requests_by_type['fetch_attachments']).toBe(2);
    expect(costB.requests_by_type['delta_sync']).toBeUndefined();
  });
});
