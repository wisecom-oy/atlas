import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scope_connector_throttling, with_graph_retry } from '@wisecom/atlas-m365-graph';
import { InProcessThrottleCoordinator } from '@wisecom/atlas-core/services/shared/in-process-throttle-coordinator';
import type {
  TeamsConnector,
  TeamsIndexRepository,
  TeamsChannelShardRepository,
  TeamsChannelCursorRepository,
  TeamsChannelCheckpointRepository,
  TenantContextFactory,
  TenantContext,
} from '@wisecom/atlas-types';
import { TeamsBackupService } from '@/services/backup/backup.service';
import { TEAM_ID, TENANT_ID } from './backup-service-harness';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';

vi.mock('@wisecom/atlas-core/services/shared/run-object-lock', () => ({
  attach_run_retention: vi.fn(async (ctx: unknown) => ctx),
}));

/** A Graph 429 as the SDK delivers it: a fetch `Headers` object carrying Retry-After. */
function throttled_429(): Record<string, unknown> {
  return {
    statusCode: 429,
    message: 'Too Many Requests',
    headers: new Headers({ 'retry-after': '120' }),
  };
}

/** Builds the service over the real throttle wrapper and retry loop, with a team GET that always 429s. */
function service_with_throttled_team_get(): TeamsBackupService {
  const coordinator = new InProcessThrottleCoordinator();
  const inner = {
    get_team: vi.fn(() => with_graph_retry(() => Promise.reject(throttled_429()))),
  };
  const connector = scope_connector_throttling(
    inner as unknown as TeamsConnector,
    coordinator,
    'teams',
  );
  const factory = {
    create: vi.fn(async () => ({ destroy: vi.fn() }) as unknown as TenantContext),
  } as unknown as TenantContextFactory;
  return new TeamsBackupService(
    factory,
    connector,
    {} as TeamsIndexRepository,
    {} as TeamsChannelShardRepository,
    {} as TeamsChannelCursorRepository,
    {} as TeamsChannelCheckpointRepository,
    stub_owner_leases().leases,
  );
}

describe('TeamsBackupService.backup_team stops a throttled team GET on Ctrl+C', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects within about a second of the abort instead of waiting out Retry-After 120', async () => {
    const service = service_with_throttled_team_get();
    const controller = new AbortController();

    const promise = service.backup_team(TENANT_ID, TEAM_ID, {
      abort_signal: controller.signal,
    });
    const outcome = promise.then(
      () => 'resolved',
      () => 'rejected',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(0);

    expect(await outcome).toBe('rejected');
  });
});
