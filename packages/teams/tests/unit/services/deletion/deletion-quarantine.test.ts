import { describe, expect, it } from 'vitest';
import type { TenantContextFactory } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { TeamsDeletionService } from '@/services/deletion/deletion.service';
import { TEAMS_KEYS } from '@/services/shared/storage-keys';

const TEAM = 'a1b2c3d4-e5f6-4789-8abc-0123456789ab';
const OTHER_TEAM = 'b1b2c3d4-e5f6-4789-8abc-0123456789ab';

/**
 * Issue #694: a quarantined index still lists the team's channels and shards, so erasing the team
 * removes the quarantined copy too, and leaves every other team's alone.
 */
describe('TeamsDeletionService.delete_team_data quarantined copies', () => {
  it('removes the team quarantined indexes and keeps another team', async () => {
    const harness = in_memory_tenant_context();
    const own = `_quarantine/${TEAMS_KEYS.manifest_key(TEAM, 'teams-snap-2000-bbbbbb')}`;
    const repeat = `${own}.1700000000000`;
    const other = `_quarantine/${TEAMS_KEYS.manifest_key(OTHER_TEAM, 'teams-snap-2000-bbbbbb')}`;
    for (const key of [own, repeat, other]) harness.set_raw(key, Buffer.from('x'));
    // An unversioned bucket: no object versions, so every key is removed by a plain delete.
    harness.ctx.storage.list_versions = async () => [];
    const factory = {
      create_storage_only: async () => harness.ctx,
    } as unknown as TenantContextFactory;

    await new TeamsDeletionService(factory).delete_team_data('tenant-test', TEAM);

    expect(harness.keys()).toEqual([other]);
  });
});
