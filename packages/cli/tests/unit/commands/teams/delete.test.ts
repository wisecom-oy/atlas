import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Container } from 'inversify';
import { logger } from '@wisecom/atlas-core';
import { execute_teams_delete } from '@/commands/teams/data-ops.handlers';
import {
  TEAMS_DELETION_USE_CASE_TOKEN,
  type DeletionResult,
  type TeamsDeletionUseCase,
} from '@wisecom/atlas-types';

vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => {}) }));

const TENANT = 'tenant-example';
const TEAM = 'team-a';

function deletion_result(overrides: Partial<DeletionResult> = {}): DeletionResult {
  return {
    deleted_objects: 4,
    deleted_manifests: 1,
    retained_objects: 0,
    retained_manifests: 0,
    failed_objects: 0,
    failed_manifests: 0,
    ...overrides,
  };
}

describe('teams delete result', () => {
  let container: Container;
  let delete_team_data: Mock;

  beforeEach(() => {
    delete_team_data = vi.fn();
    container = new Container();
    container
      .bind(TEAMS_DELETION_USE_CASE_TOKEN)
      .toConstantValue({ delete_team_data } as unknown as TeamsDeletionUseCase);
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'success').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('exits 1 and reports the objects Object Lock retained (issue #634)', async () => {
    delete_team_data.mockResolvedValueOnce(
      deletion_result({ retained_objects: 13, retained_manifests: 1 }),
    );

    await execute_teams_delete(container, { tenant: TENANT, team: TEAM, yes: true });

    expect(logger.info).toHaveBeenCalledWith(
      'Retained and not deleted: 13 object(s), 1 manifest(s)',
    );
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 and reports the objects that failed to delete (issue #634)', async () => {
    delete_team_data.mockResolvedValueOnce(deletion_result({ failed_objects: 11 }));

    await execute_teams_delete(container, { tenant: TENANT, team: TEAM, yes: true });

    expect(logger.info).toHaveBeenCalledWith(
      'Failed for other reasons: 11 object(s), 0 manifest(s)',
    );
    expect(process.exitCode).toBe(1);
  });

  it('leaves the exit code alone when every object is deleted', async () => {
    delete_team_data.mockResolvedValueOnce(deletion_result());

    await execute_teams_delete(container, { tenant: TENANT, team: TEAM, yes: true });

    expect(process.exitCode).toBeUndefined();
  });
});
