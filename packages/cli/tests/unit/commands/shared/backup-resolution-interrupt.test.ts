import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import { get_active_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import {
  BACKUP_USE_CASE_TOKEN,
  CALENDAR_BACKUP_USE_CASE_TOKEN,
  CONTACTS_BACKUP_USE_CASE_TOKEN,
  ONEDRIVE_BACKUP_USE_CASE_TOKEN,
  SHAREPOINT_CONNECTOR_TOKEN,
  SHAREPOINT_SITE_TREE_BACKUP_USE_CASE_TOKEN,
  TEAMS_BACKUP_USE_CASE_TOKEN,
  TEAMS_CATALOG_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@wisecom/atlas-types';
import { EXIT_PARTIAL } from '@/command-run-outcome';
import { execute_outlook_backup } from '@/commands/outlook/backup.handlers';
import { execute_calendar_backup } from '@/commands/calendar/command.handlers';
import { execute_contacts_backup } from '@/commands/contacts/command.handlers';
import { execute_onedrive_backup } from '@/commands/onedrive/command.handlers';
import { execute_sharepoint_backup } from '@/commands/sharepoint/command.handlers';
import { execute_teams_backup } from '@/commands/teams/command.handlers';

vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => {}) }));

/**
 * Issue #876: the backup commands installed their Ctrl+C gate only after resolving the owner, site
 * or team list. A first Ctrl+C during that lookup, which an identity or Graph outage can stretch to
 * the 24-minute retry budget, killed the process with exit 130 and no `Stopping` line.
 */
const TENANT = '00000000-0000-0000-0000-000000000001';
const MAILBOX = 'john.doe@example.com';

/** Backup use cases of every workload; none may be called when Ctrl+C lands during the lookup. */
const runs = {
  sync_mailbox: vi.fn(),
  backup_calendar: vi.fn(),
  backup_contacts: vi.fn(),
  backup_onedrive: vi.fn(),
  backup_site_tree: vi.fn(),
  backup_team: vi.fn(),
};

/** The lookup every command makes before its run; set per test. */
let lookup: () => Promise<never>;

function build_container(): Container {
  const container = new Container();
  container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: TENANT });
  container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({ resolve_user: () => lookup() });
  container.bind(SHAREPOINT_CONNECTOR_TOKEN).toConstantValue({ resolve_site: () => lookup() });
  container.bind(TEAMS_CATALOG_USE_CASE_TOKEN).toConstantValue({ list_teams: () => lookup() });
  container.bind(BACKUP_USE_CASE_TOKEN).toConstantValue(runs);
  container.bind(CALENDAR_BACKUP_USE_CASE_TOKEN).toConstantValue(runs);
  container.bind(CONTACTS_BACKUP_USE_CASE_TOKEN).toConstantValue(runs);
  container.bind(ONEDRIVE_BACKUP_USE_CASE_TOKEN).toConstantValue(runs);
  container.bind(SHAREPOINT_SITE_TREE_BACKUP_USE_CASE_TOKEN).toConstantValue(runs);
  container.bind(TEAMS_BACKUP_USE_CASE_TOKEN).toConstantValue(runs);
  return container;
}

const COMMANDS: [string, (c: Container) => Promise<void>][] = [
  ['outlook backup', (c) => execute_outlook_backup(c, { mailbox: MAILBOX })],
  ['calendar backup', (c) => execute_calendar_backup(c, { mailbox: MAILBOX })],
  ['contacts backup', (c) => execute_contacts_backup(c, { mailbox: MAILBOX })],
  ['onedrive backup', (c) => execute_onedrive_backup(c, { owner: MAILBOX })],
  ['sharepoint backup', (c) => execute_sharepoint_backup(c, { site: 'https://example.com/s/x' })],
  ['teams backup --all', (c) => execute_teams_backup(c, { tenant: TENANT, all: true })],
];

/** A lookup that never answers and ignores every signal, like a token request held by an outage. */
function never_answers(): Promise<never> {
  return new Promise<never>(() => undefined);
}

describe('Ctrl+C during the lookup before a backup', () => {
  let warnings: string[];
  let exit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.exitCode = undefined;
    warnings = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    for (const run of Object.values(runs)) run.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it.each(COMMANDS)('%s: a first Ctrl+C is a soft stop with exit 2', async (_name, execute) => {
    lookup = never_answers;
    const command = execute(build_container());
    await new Promise((resolve) => setImmediate(resolve));

    process.emit('SIGINT');
    await command;

    expect(process.exitCode).toBe(EXIT_PARTIAL);
    expect(warnings.join('\n')).toContain('Stopping');
    expect(exit).not.toHaveBeenCalled();
    for (const run of Object.values(runs)) expect(run).not.toHaveBeenCalled();
  });

  it.each(COMMANDS)('%s: the lookup runs under the Ctrl+C signal', async (_name, execute) => {
    let seen: AbortSignal | undefined;
    lookup = () => {
      seen = get_active_abort_signal();
      return never_answers();
    };
    const command = execute(build_container());
    await new Promise((resolve) => setImmediate(resolve));

    process.emit('SIGINT');
    await command;

    expect(seen?.aborted).toBe(true);
  });

  it.each(COMMANDS)('%s: a Ctrl+C as the lookup ends starts no run', async (_name, execute) => {
    lookup = () => {
      process.emit('SIGINT');
      return Promise.resolve({ object_id: 'oid', site_id: 'sid', display_name: 'x' } as never);
    };

    await execute(build_container());

    expect(process.exitCode).toBe(EXIT_PARTIAL);
    for (const run of Object.values(runs)) expect(run).not.toHaveBeenCalled();
  });

  it.each(COMMANDS)('%s: a second Ctrl+C still exits 130 at once', async (_name, execute) => {
    lookup = never_answers;
    const command = execute(build_container());
    await new Promise((resolve) => setImmediate(resolve));

    process.emit('SIGINT');
    process.emit('SIGINT');

    expect(exit).toHaveBeenCalledWith(130);
    await command;
  });
});
