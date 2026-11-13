import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '@wisecom/atlas-types';
import { backup_channel } from '@/services/backup/channel-backup-processor';
import { channel_output, make_ports, TEAM_ID, TENANT_ID } from './backup-service-harness';

vi.mock('@wisecom/atlas-core/services/shared/run-object-lock', () => ({
  attach_run_retention: vi.fn(async (ctx: unknown) => ctx),
}));
vi.mock('@/services/backup/channel-backup-processor', () => ({ backup_channel: vi.fn() }));

const OTHER_TENANT = '11111111-2222-3333-4444-555555555555';
const SKIP_WARNING = (channel_id: string) =>
  `Channel ${channel_id} is owned by another tenant; skipped`;

describe('TeamsBackupService channel ownership (#723)', () => {
  beforeEach(() => {
    vi.mocked(backup_channel).mockReset();
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) =>
      channel_output(channel.id),
    );
  });

  it('refuses a domain tenant with a ConfigError before any Graph call', async () => {
    const ports = make_ports();

    await expect(ports.service.backup_team('contoso.onmicrosoft.com', TEAM_ID, {})).rejects.toThrow(
      ConfigError,
    );
    await expect(ports.service.backup_team('contoso.onmicrosoft.com', TEAM_ID, {})).rejects.toThrow(
      'tenant GUID',
    );
    expect(ports.connector.get_team).not.toHaveBeenCalled();
    expect(ports.connector.list_channels).not.toHaveBeenCalled();
    expect(backup_channel).not.toHaveBeenCalled();
  });

  it('matches a channel tenantId to the tenant GUID regardless of letter case', async () => {
    const ports = make_ports({
      channels: [{ id: 'channel-1', tenantId: TENANT_ID.toUpperCase() }],
    });

    const result = await ports.service.backup_team(TENANT_ID.toUpperCase(), TEAM_ID, {});

    expect(backup_channel).toHaveBeenCalledTimes(1);
    expect(result.summary.warnings).not.toContain(SKIP_WARNING('channel-1'));
  });

  it('still skips a shared channel owned by another tenant while backing up the owned one', async () => {
    const ports = make_ports({
      channels: [{ id: 'channel-1' }, { id: 'channel-2', tenantId: OTHER_TENANT }],
    });

    const result = await ports.service.backup_team(TENANT_ID, TEAM_ID, {});

    expect(backup_channel).toHaveBeenCalledTimes(1);
    expect(vi.mocked(backup_channel).mock.calls[0]?.[1].id).toBe('channel-1');
    expect(result.summary.warnings).toContain(SKIP_WARNING('channel-2'));
    expect(result.summary.errors).toEqual([]);
  });

  it('does not report healthy when every listed channel is owned by another tenant', async () => {
    const ports = make_ports({
      channels: [
        { id: 'channel-1', tenantId: OTHER_TENANT },
        { id: 'channel-2', tenantId: OTHER_TENANT },
      ],
    });

    const result = await ports.service.backup_team(TENANT_ID, TEAM_ID, {});

    expect(backup_channel).not.toHaveBeenCalled();
    expect(result.summary.healthy).toBe(false);
    expect(result.summary.errors).toEqual([
      `Every channel of team ${TEAM_ID} is owned by another tenant; nothing was backed up`,
    ]);
    expect(result.summary.warnings).toEqual(
      expect.arrayContaining([SKIP_WARNING('channel-1'), SKIP_WARNING('channel-2')]),
    );
    expect(result.summary.no_snapshot_reason).toBeUndefined();
  });
});
