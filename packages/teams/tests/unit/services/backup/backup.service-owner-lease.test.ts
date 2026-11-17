/**
 * Issue #623: two backups of one team overwrote each other's channel cursors, and one run's
 * checkpoint cleanup deleted the checkpoint the other was resuming from. The backup now runs
 * under the team's lease.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnerBusyError, OwnerLeaseLostError } from '@wisecom/atlas-types';
import { backup_channel } from '@/services/backup/channel-backup-processor';
import { channel_output, make_ports, TEAM_ID, TENANT_ID } from './backup-service-harness';

vi.mock('@wisecom/atlas-core/services/shared/run-object-lock', () => ({
  attach_run_retention: vi.fn(async (ctx: unknown) => ctx),
}));
vi.mock('@/services/backup/channel-backup-processor', () => ({ backup_channel: vi.fn() }));

const LEASE = { workload: 'teams', owner_id: TEAM_ID, operation: 'backup' } as const;

describe('TeamsBackupService.backup_team under the team lease (issue #623)', () => {
  beforeEach(() => {
    vi.mocked(backup_channel).mockReset();
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) =>
      channel_output(channel.id),
    );
  });

  it('takes the lease before it reads the baseline and releases it after the run', async () => {
    const ports = make_ports();
    const events_at_baseline: string[] = [];
    ports.indexes.find_latest_readable.mockImplementationOnce(async () => {
      events_at_baseline.push(...ports.leases.events);
      return { index: undefined, unreadable_keys: [], unsupported_keys: [] };
    });

    await ports.service.backup_team(TENANT_ID, TEAM_ID.toUpperCase());

    expect(ports.leases.requests).toEqual([LEASE]);
    expect(events_at_baseline).toEqual(['acquire']);
    expect(ports.order.slice(0, 2).sort()).toEqual(['shard:channel-1', 'shard:channel-2']);
    expect(ports.leases.events.at(-1)).toBe('release');
    expect(ports.leases.held()).toBe(0);
  });

  it('hands every channel the lease, so a checkpoint is not advanced once it is lost', async () => {
    const ports = make_ports();

    await ports.service.backup_team(TENANT_ID, TEAM_ID);

    const scope = vi.mocked(backup_channel).mock.calls[0]?.[0];
    expect(() => scope?.lease.assert_held()).not.toThrow();
    expect(scope?.lease.storage_key).toBe(`stub-lease/teams/${TEAM_ID}.json`);
  });

  it('fails before reading anything and writes nothing while another run holds the team', async () => {
    const ports = make_ports();
    ports.leases.refuse_with(new OwnerBusyError({ ...LEASE, held_by_operation: 'backup' }));

    await expect(ports.service.backup_team(TENANT_ID, TEAM_ID)).rejects.toBeInstanceOf(
      OwnerBusyError,
    );

    expect(ports.connector.get_team).not.toHaveBeenCalled();
    expect(ports.indexes.find_latest_readable).not.toHaveBeenCalled();
    expect(ports.cursors.load).not.toHaveBeenCalled();
    expect(backup_channel).not.toHaveBeenCalled();
    expect(ports.order).toEqual([]);
  });

  it('writes no shard, index or cursor once the lease is lost mid-run', async () => {
    const ports = make_ports();
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) => {
      ports.leases.fail_checks_with(new OwnerLeaseLostError(LEASE, 'another run replaced it'));
      return channel_output(channel.id);
    });

    await expect(ports.service.backup_team(TENANT_ID, TEAM_ID)).rejects.toBeInstanceOf(
      OwnerLeaseLostError,
    );

    expect(ports.order).toEqual([]);
    expect(ports.leases.held()).toBe(0);
  });

  it('releases the lease when the run fails', async () => {
    const ports = make_ports();
    ports.connector.list_channels.mockRejectedValue(new Error('graph unavailable'));

    await expect(ports.service.backup_team(TENANT_ID, TEAM_ID)).rejects.toThrow(
      'graph unavailable',
    );

    expect(ports.leases.events).toEqual(['acquire', 'release']);
  });

  it('releases the lease when the run is interrupted', async () => {
    const ports = make_ports();
    const controller = new AbortController();
    controller.abort();

    const result = await ports.service.backup_team(TENANT_ID, TEAM_ID, {
      abort_signal: controller.signal,
    });

    expect(result.interrupted).toBe(true);
    expect(ports.leases.held()).toBe(0);
  });
});
