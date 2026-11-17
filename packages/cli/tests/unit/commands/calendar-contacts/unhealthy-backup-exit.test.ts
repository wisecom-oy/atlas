import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import { logger } from '@wisecom/atlas-core';
import {
  CALENDAR_BACKUP_USE_CASE_TOKEN,
  CONTACTS_BACKUP_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@wisecom/atlas-types';
import { EXIT_PARTIAL } from '@/command-run-outcome';
import { EXIT_CONTENT_UNREADABLE } from '@/command-unreadable-objects';
import { execute_calendar_backup } from '@/commands/calendar/command.handlers';
import { execute_contacts_backup } from '@/commands/contacts/command.handlers';

vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => {}) }));

const TENANT = 'tenant-example';
const MAILBOX = 'owner-1';

/** An item error the service records, which makes the run unhealthy and partial (exit 2). */
const ITEM_ERROR = ['item-1: fetch failed (attempt 5/5)'];

/** The run's findings, as the services return them. */
interface Findings {
  readonly healthy: boolean;
  readonly errors: readonly string[];
  readonly unreadable_keys?: readonly string[];
}

const workloads = [
  {
    name: 'Calendar',
    /** A newest manifest the run could not read (issue #742). */
    damaged: ['calendar/manifests/owner-1/cal-snap-9999-abc.json'],
    run: (container: Container, findings: Findings) => {
      container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({ resolve_user: vi.fn() });
      container.bind(CALENDAR_BACKUP_USE_CASE_TOKEN).toConstantValue({
        backup_calendar: vi.fn().mockResolvedValue({
          snapshot: undefined,
          interrupted: false,
          summary: {
            events_changed: 0,
            events_removed: 0,
            objects_stored: 0,
            calendars_skipped: 0,
            attachments_skipped: 0,
            warnings: [],
            ...findings,
          },
        }),
      });
      return execute_calendar_backup(container, { tenant: TENANT, mailbox: MAILBOX });
    },
  },
  {
    name: 'Contacts',
    /** A newest manifest the run could not read (issue #742). */
    damaged: ['contacts/manifests/owner-1/con-snap-9999-abc.json'],
    run: (container: Container, findings: Findings) => {
      container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({ resolve_user: vi.fn() });
      container.bind(CONTACTS_BACKUP_USE_CASE_TOKEN).toConstantValue({
        backup_contacts: vi.fn().mockResolvedValue({
          snapshot: undefined,
          interrupted: false,
          summary: {
            contacts_changed: 0,
            contacts_removed: 0,
            objects_stored: 0,
            ...findings,
          },
        }),
      });
      return execute_contacts_backup(container, { tenant: TENANT, mailbox: MAILBOX });
    },
  },
];

describe.each(workloads)('$name backup verdict and exit code', ({ run, damaged }) => {
  beforeEach(() => {
    process.exitCode = undefined;
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'success').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('prints HEALTHY and exits 0 on a clean run', async () => {
    await run(new Container(), { healthy: true, errors: [] });

    expect(logger.success).toHaveBeenCalledWith('Status: HEALTHY');
    expect(logger.error).not.toHaveBeenCalledWith('Status: UNHEALTHY');
    expect(process.exitCode).toBeUndefined();
  });

  it('prints UNHEALTHY, never HEALTHY, and exits 9 when the only finding is a damaged manifest', async () => {
    await run(new Container(), { healthy: true, errors: [], unreadable_keys: damaged });

    expect(logger.success).not.toHaveBeenCalledWith('Status: HEALTHY');
    expect(logger.error).toHaveBeenCalledWith('Status: UNHEALTHY');
    expect(logger.error).toHaveBeenCalledWith(`  Unreadable stored object: ${damaged[0]}`);
    expect(process.exitCode).toBe(EXIT_CONTENT_UNREADABLE);
  });

  it('prints UNHEALTHY and exits 2 when a damaged manifest and item errors both occur', async () => {
    await run(new Container(), { healthy: false, errors: ITEM_ERROR, unreadable_keys: damaged });

    expect(logger.success).not.toHaveBeenCalledWith('Status: HEALTHY');
    expect(logger.error).toHaveBeenCalledWith('Status: UNHEALTHY');
    expect(process.exitCode).toBe(EXIT_PARTIAL);
  });
});
