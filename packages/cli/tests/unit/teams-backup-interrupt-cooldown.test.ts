import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import { InProcessThrottleCoordinator } from '@wisecom/atlas-core/services/shared/in-process-throttle-coordinator';
import { execute_teams_backup } from '@/commands/teams-command.handlers';
import { render_static_view } from '@/ui/render';
import {
  TEAMS_BACKUP_USE_CASE_TOKEN,
  TEAMS_CATALOG_USE_CASE_TOKEN,
  THROTTLE_COORDINATOR_TOKEN,
  type TeamsBackupUseCase,
  type TeamsCatalogUseCase,
} from '@wisecom/atlas-types';

vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => {}) }));

/**
 * Q6. Ctrl+C aborts a throttled team GET, but the 120 s Retry-After cooldown the run raised is a
 * live, not-unref'd timer. The process then sat for two minutes after the interrupted run. The
 * handler must release the cooldown once an interrupted run ends.
 */
describe('teams backup Ctrl+C with a Retry-After cooldown in force', () => {
  let container: Container;
  let coordinator: InProcessThrottleCoordinator;

  beforeEach(() => {
    vi.useFakeTimers();
    process.exitCode = undefined;
    coordinator = new InProcessThrottleCoordinator();
    container = new Container();
    container
      .bind(THROTTLE_COORDINATOR_TOKEN)
      .toConstantValue(coordinator)
      .onDeactivation(() => coordinator.clear());
    container.bind(TEAMS_CATALOG_USE_CASE_TOKEN).toConstantValue({
      list_teams: vi.fn(),
    } as unknown as TeamsCatalogUseCase);
    // The Teams connector resolves the coordinator during a run. Deactivation only runs for
    // resolved bindings, so resolve it here as that run would.
    container.get(THROTTLE_COORDINATOR_TOKEN);
    container.bind(TEAMS_BACKUP_USE_CASE_TOKEN).toConstantValue({
      backup_team: (_tenant: string, _team: string, options: { abort_signal?: AbortSignal }) => {
        coordinator.raise('teams', 120_000);
        const { promise, reject } = Promise.withResolvers<never>();
        options.abort_signal?.addEventListener('abort', () =>
          reject(new Error('Run interrupted by Ctrl+C')),
        );
        return promise;
      },
    } as unknown as TeamsBackupUseCase);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('leaves no cooldown timer behind after the interrupted run ends', async () => {
    const run = execute_teams_backup(container, { tenant: 'tenant-example', team: ['team-a'] });
    await vi.advanceTimersByTimeAsync(1_000);

    process.emit('SIGINT');
    await run;

    expect(render_static_view).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
