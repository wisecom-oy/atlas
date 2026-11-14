import { describe, expect, it } from 'vitest';
import { UnsupportedFormatVersionError } from '@wisecom/atlas-types';
import {
  owner_id_of_lease_key,
  owner_lease_key,
  TENANT_LEASE_KEY,
} from '@/services/lease/owner-lease-key';
import { find_live_owner_lease } from '@/services/lease/owner-lease-scan';
import { lease_harness, MINUTE_MS, START_MS, OUTLOOK_KEY } from './owner-lease-harness';

const ONEDRIVE_KEY = owner_lease_key('onedrive', 'drive-1');
const PAST = new Date(START_MS - MINUTE_MS).toISOString();

describe('owner_id_of_lease_key', () => {
  it('reads the owner back from each workload layout', () => {
    expect(owner_id_of_lease_key('outlook', OUTLOOK_KEY)).toBe('owner-1');
    expect(owner_id_of_lease_key('onedrive', ONEDRIVE_KEY)).toBe('drive-1');
  });

  it('rejects keys that are not exactly an owner lease of that workload', () => {
    expect(owner_id_of_lease_key('onedrive', 'onedrive/_meta/drive-1/cursor.json')).toBeUndefined();
    expect(owner_id_of_lease_key('onedrive', 'onedrive/_meta/a/b/lease.json')).toBeUndefined();
    expect(owner_id_of_lease_key('onedrive', 'sharepoint/_meta/x/lease.json')).toBeUndefined();
    expect(owner_id_of_lease_key('outlook', '_meta/outlook-leases/a/b.json')).toBeUndefined();
    expect(owner_id_of_lease_key('outlook', '_meta/outlook-leases/owner-1.txt')).toBeUndefined();
    expect(owner_id_of_lease_key('outlook', TENANT_LEASE_KEY)).toBeUndefined();
  });

  it('keeps the tenant lease out of every owner layout', () => {
    expect(owner_lease_key('tenant', 'tenant-test')).toBe('_meta/tenant-lease.json');
    expect(TENANT_LEASE_KEY.startsWith('_meta/outlook-leases/')).toBe(false);
    expect(TENANT_LEASE_KEY.startsWith('onedrive/_meta/')).toBe(false);
  });
});

describe('find_live_owner_lease', () => {
  it('finds nothing in a tenant without leases', async () => {
    const h = lease_harness();

    expect(await find_live_owner_lease(h.ctx, h.now())).toBeUndefined();
  });

  it('returns the live owner lease, with the workload and owner it covers', async () => {
    const h = lease_harness();
    h.store({ operation: 'backup' }, ONEDRIVE_KEY);

    const found = await find_live_owner_lease(h.ctx, h.now());

    expect(found).toMatchObject({ workload: 'onedrive', owner_id: 'drive-1' });
    expect(found?.record.operation).toBe('backup');
  });

  it('skips expired, released and damaged leases', async () => {
    const h = lease_harness();
    h.store({ expires_at: PAST }, ONEDRIVE_KEY);
    h.store({ released_at: new Date(START_MS).toISOString() }, owner_lease_key('contacts', 'a'));
    h.bucket.set_raw(owner_lease_key('calendar', 'b'), Buffer.from('{'));

    expect(await find_live_owner_lease(h.ctx, h.now())).toBeUndefined();
  });

  it('does not read an object that is not an owner lease key, even one with a lease body', async () => {
    const h = lease_harness();
    h.store({ operation: 'backup' }, 'onedrive/_meta/drive-1/cursor.json');

    expect(await find_live_owner_lease(h.ctx, h.now())).toBeUndefined();
  });

  it('ignores a live tenant lease, which no owner listing names', async () => {
    const h = lease_harness();
    h.store({ operation: 'purge' }, TENANT_LEASE_KEY);

    expect(await find_live_owner_lease(h.ctx, h.now())).toBeUndefined();
  });

  it('fails closed on a lease a newer Atlas wrote', async () => {
    const h = lease_harness();
    h.store({ format_version: 2 }, ONEDRIVE_KEY);

    await expect(find_live_owner_lease(h.ctx, h.now())).rejects.toBeInstanceOf(
      UnsupportedFormatVersionError,
    );
  });
});
