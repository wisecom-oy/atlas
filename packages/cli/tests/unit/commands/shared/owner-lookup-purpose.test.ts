import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Container } from 'inversify';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import {
  CATALOG_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
  type ResolveUserOptions,
} from '@wisecom/atlas-types';
import { resolve_owner, resolve_stored_owner } from '@/commands/shared/owner-resolution';
import { execute_outlook_list } from '@/commands/outlook/catalog.handlers';
import { execute_outlook_verify } from '@/commands/outlook/mgmt.handlers';
import { execute_outlook_backup } from '@/commands/outlook/backup.handlers';
import { execute_onedrive_verify } from '@/commands/onedrive/command.handlers';
import { execute_onedrive_list_snapshots } from '@/commands/onedrive/catalog.handlers';
import {
  execute_onedrive_delete,
  execute_onedrive_status,
} from '@/commands/onedrive/data-ops.handlers';
import { execute_calendar_verify } from '@/commands/calendar/command.handlers';
import { execute_contacts_list } from '@/commands/contacts/data-ops.handlers';

vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => {}) }));

/**
 * Issue #887: a command that only reads stored backups asks for its owner with the
 * `stored_backups` purpose, so the identity registry answers a known address after a short Graph
 * wait. Backup, restore, status and delete keep the Graph-first `microsoft_365` lookup, so a
 * recycled address maps to its current owner.
 */
const TENANT = 'tenant-abc';
const ADDRESS = 'john.doe@example.com';
const OBJECT_ID = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
/** Thrown by the resolver stub, so a handler stops right after its lookup. */
const LOOKED_UP = new Error('looked up');

/** Any port the handler reaches for before its lookup: every method resolves undefined. */
function any_port(): unknown {
  return new Proxy(
    {},
    { get: (_t, prop) => (prop === 'then' ? undefined : async () => undefined) },
  );
}

function make_container(resolve_user: ReturnType<typeof vi.fn>): Container {
  const catalog = { get_snapshot_detail: async () => ({ owner_id: 'another-owner' }) };
  return {
    get: (token: unknown) => {
      if (token === ATLAS_CONFIG_TOKEN) return { tenant_id: TENANT };
      if (token === USER_IDENTITY_RESOLVER_TOKEN) return { resolve_user };
      if (token === CATALOG_USE_CASE_TOKEN) return catalog;
      return any_port();
    },
    isBound: () => false,
  } as unknown as Container;
}

type Handler = (container: Container) => Promise<void>;

const STORED_BACKUP_READS: [string, Handler][] = [
  ['outlook list -m', (c) => execute_outlook_list(c, { mailbox: ADDRESS })],
  ['outlook verify -m', (c) => execute_outlook_verify(c, { mailbox: ADDRESS, snapshot: 's1' })],
  ['onedrive verify', (c) => execute_onedrive_verify(c, { owner: ADDRESS, snapshot: 's1' })],
  ['onedrive list-snapshots', (c) => execute_onedrive_list_snapshots(c, { owner: ADDRESS })],
  ['calendar verify', (c) => execute_calendar_verify(c, { mailbox: ADDRESS, snapshot: 's1' })],
  ['contacts list', (c) => execute_contacts_list(c, { mailbox: ADDRESS })],
];

const LIVE_DATA_COMMANDS: [string, Handler][] = [
  ['outlook backup', (c) => execute_outlook_backup(c, { mailbox: ADDRESS })],
  ['onedrive status', (c) => execute_onedrive_status(c, { owner: ADDRESS })],
  ['onedrive delete', (c) => execute_onedrive_delete(c, { owner: ADDRESS, yes: true })],
];

/** The options the handler passed to the identity resolver. */
async function lookup_options(handler: Handler): Promise<ResolveUserOptions | undefined> {
  const resolve_user = vi.fn().mockRejectedValue(LOOKED_UP);
  await expect(handler(make_container(resolve_user))).rejects.toBe(LOOKED_UP);
  expect(resolve_user).toHaveBeenCalledWith(TENANT, ADDRESS, expect.anything());
  return resolve_user.mock.calls[0]?.[2] as ResolveUserOptions | undefined;
}

describe('owner lookup purpose per command', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(STORED_BACKUP_READS)('%s lets the registry answer after a short wait', async (_n, h) => {
    expect(await lookup_options(h)).toEqual({ purpose: 'stored_backups' });
  });

  it.each(LIVE_DATA_COMMANDS)('%s resolves through Graph first', async (_n, h) => {
    expect(await lookup_options(h)).toEqual({ purpose: 'microsoft_365' });
  });

  it.each([
    ['resolve_owner', resolve_owner],
    ['resolve_stored_owner', resolve_stored_owner],
  ])('%s uses an object ID as given, with no lookup', async (_n, resolve) => {
    const resolve_user = vi.fn();

    const owner = await resolve(make_container(resolve_user), TENANT, OBJECT_ID);

    expect(owner).toEqual({ object_id: OBJECT_ID });
    expect(resolve_user).not.toHaveBeenCalled();
  });
});
