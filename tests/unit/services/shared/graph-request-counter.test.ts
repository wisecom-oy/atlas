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

  it('records a single request to the outlook pool', () => {
    const counter = new GraphRequestCounter();
    counter.record('outlook', 'delta_sync');

    const cost = counter.snapshot();
    expect(cost.requests_total).toBe(1);
    expect(cost.by_service.outlook).toEqual({
      requests: 1,
      resource_units: 1,
      upload_bytes: 0,
    });
    expect(cost.requests_by_type['delta_sync']).toBe(1);
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

  it('accumulates resource_units correctly for varying costs', () => {
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

    const cost = counter.snapshot();
    expect(cost.by_service.outlook?.upload_bytes).toBe(3072);
  });

  it('counts requests_by_type across pools', () => {
    const counter = new GraphRequestCounter();
    counter.record('outlook', 'delta_sync');
    counter.record('outlook', 'delta_sync');
    counter.record('identity', 'list_users');
    counter.record('outlook', 'fetch_attachments');

    const cost = counter.snapshot();
    expect(cost.requests_by_type['delta_sync']).toBe(2);
    expect(cost.requests_by_type['list_users']).toBe(1);
    expect(cost.requests_by_type['fetch_attachments']).toBe(1);
  });

  it('snapshot returns a copy - counter can still accumulate', () => {
    const counter = new GraphRequestCounter();
    counter.record('outlook', 'delta_sync');
    const first = counter.snapshot();

    counter.record('outlook', 'fetch_attachments');
    const second = counter.snapshot();

    expect(first.requests_total).toBe(1);
    expect(second.requests_total).toBe(2);
  });

  it('snapshot elapsed_ms is non-negative', () => {
    const counter = new GraphRequestCounter();
    const cost = counter.snapshot();
    expect(cost.elapsed_ms).toBeGreaterThanOrEqual(0);
  });
});

describe('run_with_cost_tracking and get_active_counter', () => {
  it('get_active_counter returns undefined outside a tracking context', () => {
    expect(get_active_counter()).toBeUndefined();
  });

  it('run_with_cost_tracking returns [result, cost] tuple', async () => {
    const [result, cost] = await run_with_cost_tracking(async () => 'hello');
    expect(result).toBe('hello');
    expect(cost.requests_total).toBe(0);
    expect(cost.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it('get_active_counter returns the counter inside a tracking context', async () => {
    await run_with_cost_tracking(async () => {
      const counter = get_active_counter();
      expect(counter).toBeDefined();
      counter!.record('outlook', 'list_folders');
    });
  });

  it('requests recorded inside the fn appear in the returned cost', async () => {
    const [, cost] = await run_with_cost_tracking(async () => {
      get_active_counter()?.record('outlook', 'delta_sync');
      get_active_counter()?.record('outlook', 'fetch_attachments');
      get_active_counter()?.record('identity', 'mailbox_exists', { resource_units: 1 });
    });

    expect(cost.requests_total).toBe(3);
    expect(cost.by_service.outlook?.requests).toBe(2);
    expect(cost.by_service.identity?.requests).toBe(1);
    expect(cost.requests_by_type['delta_sync']).toBe(1);
    expect(cost.requests_by_type['fetch_attachments']).toBe(1);
    expect(cost.requests_by_type['mailbox_exists']).toBe(1);
  });

  it('nested calls get isolated counters', async () => {
    const [, outer_cost] = await run_with_cost_tracking(async () => {
      get_active_counter()?.record('outlook', 'list_folders');

      const [, inner_cost] = await run_with_cost_tracking(async () => {
        get_active_counter()?.record('outlook', 'delta_sync');
        get_active_counter()?.record('outlook', 'delta_sync');
      });

      expect(inner_cost.requests_total).toBe(2);
    });

    // Outer counter should not include the inner records
    expect(outer_cost.requests_total).toBe(1);
    expect(outer_cost.requests_by_type['list_folders']).toBe(1);
    expect(outer_cost.requests_by_type['delta_sync']).toBeUndefined();
  });

  it('concurrent calls do not share counters', async () => {
    const [cost_a, cost_b] = await Promise.all([
      run_with_cost_tracking(async () => {
        await new Promise<void>((r) => setTimeout(r, 10));
        get_active_counter()?.record('outlook', 'delta_sync');
        return 'a';
      }).then(([, cost]) => cost),
      run_with_cost_tracking(async () => {
        get_active_counter()?.record('outlook', 'fetch_attachments');
        get_active_counter()?.record('outlook', 'fetch_attachments');
        return 'b';
      }).then(([, cost]) => cost),
    ]);

    expect(cost_a.requests_total).toBe(1);
    expect(cost_a.requests_by_type['delta_sync']).toBe(1);
    expect(cost_b.requests_total).toBe(2);
    expect(cost_b.requests_by_type['fetch_attachments']).toBe(2);
  });
});
