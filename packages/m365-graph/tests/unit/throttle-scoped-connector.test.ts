import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphServicePool, ThrottleCoordinator } from '@wisecom/atlas-types';
import {
  get_active_throttle,
  run_with_graph_operation,
} from '@wisecom/atlas-core/services/shared/graph-request-context';
import { InProcessThrottleCoordinator } from '@wisecom/atlas-core/services/shared/in-process-throttle-coordinator';
import { scope_connector_throttling } from '@/throttle-scoped-connector';
import { with_graph_retry } from '@/graph-request-error-handler';

const throttled = {
  statusCode: 429,
  message: 'Too Many Requests',
  headers: { 'retry-after': '20' },
};

/** A host coordinator that records every call, standing in for one backed by shared state. */
function recording_coordinator(): ThrottleCoordinator & {
  waits: GraphServicePool[];
  raises: Array<[GraphServicePool, number]>;
} {
  const waits: GraphServicePool[] = [];
  const raises: Array<[GraphServicePool, number]> = [];
  return {
    waits,
    raises,
    wait: async (pool) => {
      waits.push(pool);
    },
    raise: (pool, ms) => {
      raises.push([pool, ms]);
    },
  };
}

class StubDriveConnector {
  label = 'drive';
  #secret = 'private';
  calls = 0;

  async list_drives(): Promise<string> {
    return with_graph_retry(async () => {
      this.calls++;
      if (this.calls === 1) throw throttled;
      return this.#secret;
    });
  }

  async list_users(): Promise<void> {
    await run_with_graph_operation({ pool: 'identity', request_type: 'list_users' }, () =>
      with_graph_retry(async () => undefined),
    );
  }

  describe_sync(): string {
    return `${this.label}:${this.#secret}`;
  }
}

describe('scope_connector_throttling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('consults the coordinator on every attempt and reports the 429 against the drive pool', async () => {
    const coordinator = recording_coordinator();
    const connector = scope_connector_throttling(
      new StubDriveConnector(),
      coordinator,
      'sharepoint_onedrive',
    );

    const result = connector.list_drives();
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(result).resolves.toBe('private');
    expect(coordinator.waits).toEqual(['sharepoint_onedrive', 'sharepoint_onedrive']);
    expect(coordinator.raises).toEqual([['sharepoint_onedrive', 20_000]]);
  });

  it('charges a request that declares its own operation to that pool', async () => {
    const coordinator = recording_coordinator();
    const connector = scope_connector_throttling(new StubDriveConnector(), coordinator, 'outlook');

    await connector.list_users();

    expect(coordinator.waits).toEqual(['identity']);
  });

  it('keeps synchronous methods synchronous and plain properties untouched', () => {
    const connector = scope_connector_throttling(
      new StubDriveConnector(),
      recording_coordinator(),
      'sharepoint_onedrive',
    );

    expect(connector.describe_sync()).toBe('drive:private');
    expect(connector.label).toBe('drive');
  });

  it('publishes the coordinator only for the duration of the call', async () => {
    const coordinator = new InProcessThrottleCoordinator();
    let seen: unknown;
    const inner = {
      probe: async () => {
        seen = get_active_throttle();
      },
    };

    await scope_connector_throttling(inner, coordinator, 'sharepoint_onedrive').probe();

    expect(seen).toEqual({ coordinator, pool: 'sharepoint_onedrive' });
    expect(get_active_throttle()).toBeUndefined();
  });

  it('pauses another scoped connector on the same pool after a 429', async () => {
    const coordinator = new InProcessThrottleCoordinator();
    const first = scope_connector_throttling(
      new StubDriveConnector(),
      coordinator,
      'sharepoint_onedrive',
    );
    const second = scope_connector_throttling(
      new StubDriveConnector(),
      coordinator,
      'sharepoint_onedrive',
    );

    void first.list_drives();
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.is_cooling('sharepoint_onedrive')).toBe(true);

    const other = second.describe_sync();
    let finished = false;
    const pending = second.list_users().then(() => (finished = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(other).toBe('drive:private');
    // The identity request declares its own pool, so the drive cooldown does not hold it.
    expect(finished).toBe(true);
    await pending;

    let drive_done = false;
    const drive = second.list_drives().then(() => (drive_done = true));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(drive_done).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    await drive;
    expect(drive_done).toBe(true);
    coordinator.clear();
  });
});
