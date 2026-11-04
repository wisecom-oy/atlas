import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get_active_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { backup_channel } from '@/services/backup/channel-backup-processor';
import { channel_output, make_ports, TEAM_ID } from './backup-service-harness';

vi.mock('@wisecom/atlas-core/services/shared/run-object-lock', () => ({
  lock_run_writes: vi.fn(async (ctx: unknown) => ctx),
}));
vi.mock('@/services/backup/channel-backup-processor', () => ({ backup_channel: vi.fn() }));

describe('TeamsBackupService.backup_team abort signal', () => {
  beforeEach(() => {
    vi.mocked(backup_channel).mockReset();
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) =>
      channel_output(channel.id),
    );
  });

  it('stops before the first channel when the abort signal is already aborted', async () => {
    const ports = make_ports();
    const controller = new AbortController();
    controller.abort();

    const result = await ports.service.backup_team('tenant-1', TEAM_ID, {
      abort_signal: controller.signal,
    });

    expect(backup_channel).not.toHaveBeenCalled();
    expect(result.interrupted).toBe(true);
    expect(result.summary.healthy).toBe(false);
  });

  it('stops before the next channel when the signal aborts during a channel', async () => {
    const ports = make_ports();
    const controller = new AbortController();
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) => {
      controller.abort();
      return channel_output(channel.id);
    });

    const result = await ports.service.backup_team('tenant-1', TEAM_ID, {
      abort_signal: controller.signal,
    });

    expect(backup_channel).toHaveBeenCalledTimes(1);
    expect(result.interrupted).toBe(true);
  });

  it('ends with an interrupted progress phase, not completed, when the signal aborts (P7)', async () => {
    const ports = make_ports();
    const controller = new AbortController();
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) => {
      controller.abort();
      return channel_output(channel.id);
    });
    const phases: string[] = [];

    await ports.service.backup_team('tenant-1', TEAM_ID, {
      abort_signal: controller.signal,
      on_progress: (event) => phases.push(event.phase),
    });

    expect(phases.at(-1)).toBe('interrupted');
    expect(phases).not.toContain('completed');
  });

  it('publishes the abort signal to the Graph calls made while a channel runs', async () => {
    const ports = make_ports();
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) => {
      seen = get_active_abort_signal();
      return channel_output(channel.id);
    });

    await ports.service.backup_team('tenant-1', TEAM_ID, { abort_signal: controller.signal });

    expect(seen).toBe(controller.signal);
  });
});
