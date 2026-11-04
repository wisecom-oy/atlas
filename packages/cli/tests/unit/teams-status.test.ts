import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Container } from 'inversify';
import { logger } from '@wisecom/atlas-core';
import { execute_teams_status } from '@/commands/teams-data-ops.handlers';
import {
  TEAMS_STATUS_USE_CASE_TOKEN,
  type TeamsStatusUseCase,
  type TeamsTeamStatus,
} from '@wisecom/atlas-types';

vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => {}) }));

const TENANT = 'tenant-example';
const UNREADABLE_KEY = 'teams/_meta/team-a/channels/channel-1.json';
const UNSUPPORTED_KEY = 'teams/manifests/team-a/teams-snap-2000-bbbbbb.json';

function team(overrides: Partial<TeamsTeamStatus>): TeamsTeamStatus {
  return {
    team_id: 'team-a',
    team_display_name: 'Finance',
    last_backup_at: undefined,
    last_snapshot_id: undefined,
    total_channels: 0,
    unreadable_keys: [],
    unsupported_keys: [],
    failed_root_count: 0,
    ...overrides,
  };
}

describe('teams status warnings', () => {
  let container: Container;
  let check_teams_status: Mock;

  beforeEach(() => {
    check_teams_status = vi.fn();
    container = new Container();
    container
      .bind(TEAMS_STATUS_USE_CASE_TOKEN)
      .toConstantValue({ check_teams_status } as unknown as TeamsStatusUseCase);
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns with the keys of unreadable and newer-format objects (P9)', async () => {
    check_teams_status.mockResolvedValueOnce([
      team({ unreadable_keys: [UNREADABLE_KEY], unsupported_keys: [UNSUPPORTED_KEY] }),
    ]);

    await execute_teams_status(container, { tenant: TENANT });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(UNREADABLE_KEY));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(UNSUPPORTED_KEY));
  });

  it('warns with the failed-root count for a team that has failed roots (P9)', async () => {
    check_teams_status.mockResolvedValueOnce([team({ failed_root_count: 3 })]);

    await execute_teams_status(container, { tenant: TENANT });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('3 channel root(s) failed'));
  });

  it('prints no warnings for a healthy team', async () => {
    check_teams_status.mockResolvedValueOnce([team({})]);

    await execute_teams_status(container, { tenant: TENANT });

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
