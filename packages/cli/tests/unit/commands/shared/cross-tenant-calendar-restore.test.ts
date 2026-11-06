import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { Container } from 'inversify';
import { ATLAS_CONFIG_TOKEN, GRAPH_IDENTITY_RESOLVER_TOKEN } from '@wisecom/atlas-core';
import {
  CALENDAR_RESTORE_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@wisecom/atlas-types';
import { register_calendar_command } from '@/commands/calendar/calendar.command';

const compose_target_container = vi.hoisted(() => vi.fn());
vi.mock('@/container', () => ({ compose_target_container }));

type Binding = readonly [symbol, unknown];

/** A container with the source tenant's config plus the given service bindings. */
function make_container(tenant_id: string, bindings: Binding[]): Container {
  const container = new Container();
  container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id });
  for (const [token, value] of bindings) container.bind(token).toConstantValue(value);
  return container;
}

describe('cross-tenant calendar restore with --target-profile', () => {
  let previous_exit_code: typeof process.exitCode;

  beforeEach(() => {
    previous_exit_code = process.exitCode;
    process.exitCode = undefined;
    compose_target_container.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = previous_exit_code;
  });

  it('writes through the target profile container with the source tenant', async () => {
    const source_restore = { restore_calendar: vi.fn() };
    const target_restore = {
      restore_calendar: vi.fn().mockResolvedValue({
        snapshot_id: 'snap-1',
        events_restored: 0,
        events_skipped: 0,
        calendars_created: 0,
        errors: [],
        interrupted: false,
      }),
    };
    const source = make_container('tenant-src', [
      [USER_IDENTITY_RESOLVER_TOKEN, { resolve_user: vi.fn() }],
      [CALENDAR_RESTORE_USE_CASE_TOKEN, source_restore],
    ]);
    const target = make_container('tenant-dst', [
      [GRAPH_IDENTITY_RESOLVER_TOKEN, { resolve_user: vi.fn() }],
      [CALENDAR_RESTORE_USE_CASE_TOKEN, target_restore],
    ]);
    compose_target_container.mockReturnValue(target);

    const program = new Command();
    register_calendar_command(program, () => source);
    await program.parseAsync(
      [
        'calendar',
        'restore',
        '-m',
        'src-id',
        '-s',
        'snap-1',
        '-T',
        'dst-id',
        '--target-profile',
        'ops',
      ],
      { from: 'user' },
    );

    expect(target_restore.restore_calendar).toHaveBeenCalledWith(
      'tenant-src',
      'src-id',
      expect.objectContaining({ snapshot_id: 'snap-1', target_mailbox_id: 'dst-id' }),
    );
    expect(source_restore.restore_calendar).not.toHaveBeenCalled();
  });
});
