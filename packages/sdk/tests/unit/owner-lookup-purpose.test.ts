import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { Container } from 'inversify';
import { USER_IDENTITY_RESOLVER_TOKEN, type ResolveUserOptions } from '@wisecom/atlas-types';
import { create_onedrive_api } from '@/onedrive-api.factory';
import { create_outlook_api } from '@/outlook-api.factory';
import { create_calendar_api } from '@/calendar-api.factory';
import { create_contacts_api } from '@/contacts-api.factory';

/**
 * Issue #887: SDK methods that only read stored backups resolve an address with the
 * `stored_backups` purpose, so the identity registry answers a known address after a short Graph
 * wait instead of the 24-minute retry budget. Methods that work on live data keep `microsoft_365`,
 * which also ends on an exhausted budget instead of falling back (issue #882).
 */
const TENANT_ID = 'tenant-1';
const EMAIL = 'john.doe@example.com';
/** Thrown by the resolver stub, so a method stops right after its lookup. */
const LOOKED_UP = new Error('looked up');

/** A container whose resolver rejects with LOOKED_UP and whose other ports do nothing. */
function lookup_container(): { container: Container; resolve_user: ReturnType<typeof vi.fn> } {
  const resolve_user = vi.fn().mockRejectedValue(LOOKED_UP);
  const any_port = new Proxy(
    {},
    { get: (_t, prop) => (prop === 'then' ? undefined : async () => undefined) },
  );
  const container = {
    get: (token: unknown) => (token === USER_IDENTITY_RESOLVER_TOKEN ? { resolve_user } : any_port),
  } as unknown as Container;
  return { container, resolve_user };
}

type Call = (container: Container) => Promise<unknown>;

const STORED_BACKUP_READS: [string, Call][] = [
  ['onedrive.verify', (c) => create_onedrive_api(TENANT_ID, c).verify(EMAIL, 's1')],
  [
    'onedrive.save',
    (c) =>
      create_onedrive_api(TENANT_ID, c).save(EMAIL, {
        snapshotId: 's1',
        output: new PassThrough(),
      }),
  ],
  ['onedrive.listSnapshots', (c) => create_onedrive_api(TENANT_ID, c).listSnapshots(EMAIL)],
  ['onedrive.getStats', (c) => create_onedrive_api(TENANT_ID, c).getStats(EMAIL)],
  ['outlook.listSnapshots', (c) => create_outlook_api(TENANT_ID, c).listSnapshots(EMAIL)],
  ['outlook.getMailboxStats', (c) => create_outlook_api(TENANT_ID, c).getMailboxStats(EMAIL)],
  ['outlook.saveMailbox', (c) => create_outlook_api(TENANT_ID, c).saveMailbox(EMAIL)],
  ['calendar.verify', (c) => create_calendar_api(TENANT_ID, c).verify(EMAIL, 's1')],
  ['contacts.listSnapshots', (c) => create_contacts_api(TENANT_ID, c).listSnapshots(EMAIL)],
];

const LIVE_DATA_CALLS: [string, Call][] = [
  ['outlook.backup', (c) => create_outlook_api(TENANT_ID, c).backup(EMAIL)],
  ['onedrive.backup', (c) => create_onedrive_api(TENANT_ID, c).backup(EMAIL)],
  ['onedrive.checkStatus', (c) => create_onedrive_api(TENANT_ID, c).checkStatus(EMAIL)],
  ['onedrive.deleteOwnerData', (c) => create_onedrive_api(TENANT_ID, c).deleteOwnerData(EMAIL)],
  ['calendar.backup', (c) => create_calendar_api(TENANT_ID, c).backup(EMAIL)],
];

/** The options the method passed to the identity resolver. */
async function lookup_options(call: Call): Promise<ResolveUserOptions | undefined> {
  const { container, resolve_user } = lookup_container();
  await expect(call(container)).rejects.toBe(LOOKED_UP);
  return resolve_user.mock.calls[0]?.[2] as ResolveUserOptions | undefined;
}

describe('SDK owner lookup purpose', () => {
  it.each(STORED_BACKUP_READS)('%s reads stored backups', async (_name, call) => {
    expect(await lookup_options(call)).toEqual({ purpose: 'stored_backups' });
  });

  it.each(LIVE_DATA_CALLS)('%s resolves through Graph first', async (_name, call) => {
    expect(await lookup_options(call)).toEqual({ purpose: 'microsoft_365' });
  });
});
