import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Container } from 'inversify';
import { logger } from '@wisecom/atlas-core';
import { execute_teams_verify } from '@/commands/teams/data-ops.handlers';
import {
  TEAMS_VERIFICATION_USE_CASE_TOKEN,
  type TeamsVerificationResult,
  type TeamsVerificationUseCase,
} from '@wisecom/atlas-types';

vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => {}) }));

const TENANT = 'tenant-example';
const NEWER_SHARD_KEY = 'teams/shards/team-a/channel-1/shard-name.json';

describe('teams verify result', () => {
  let container: Container;
  let verify_teams_snapshot: Mock;

  beforeEach(() => {
    verify_teams_snapshot = vi.fn();
    container = new Container();
    container
      .bind(TEAMS_VERIFICATION_USE_CASE_TOKEN)
      .toConstantValue({ verify_teams_snapshot } as unknown as TeamsVerificationUseCase);
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'success').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('counts a newer-format shard as an unsupported failure, not a blob mismatch (P12)', async () => {
    const result: TeamsVerificationResult = {
      snapshot_id: 'teams-snap-2000-bbbbbb',
      total_checked: 1,
      passed: 0,
      failed_storage_keys: [],
      missing_storage_keys: [],
      unsupported_storage_keys: [NEWER_SHARD_KEY],
      interrupted: false,
    };
    verify_teams_snapshot.mockResolvedValueOnce(result);

    await execute_teams_verify(container, { tenant: TENANT, team: 'team-a', snapshot: 'snap' });

    expect(logger.error).toHaveBeenCalledWith('Failures: missing=0, blobs=0, unsupported=1');
    expect(process.exitCode).toBe(1);
  });
});
