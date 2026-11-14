import { beforeEach, describe, expect, it } from 'vitest';
import { ReplicationStatus } from '@wisecom/atlas-types';
import {
  in_memory_tenant_context,
  type InMemoryTenantContext,
} from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import {
  TENANT,
  calendar_snapshot,
  contacts_snapshot,
  replication_service,
  seed,
  target_over,
  workload_keys,
} from './full-snapshot-replication.fixtures';

/**
 * Issue #715: `replicate -m` read only the Outlook manifests of a mailbox, so its contacts and
 * calendar snapshots never reached a replica and nothing said so. A mailbox-wide replication must
 * copy them, skip what the target already holds, and report what it could not copy.
 */
const MAILBOX = 'mbx-1';
const CONTACTS = [contacts_snapshot(MAILBOX, 1), contacts_snapshot(MAILBOX, 2)];
const CALENDAR = [calendar_snapshot(MAILBOX, 1)];
const ALL = [...CONTACTS, ...CALENDAR];

describe('replicate -m with contacts and calendar snapshots', () => {
  let primary: InMemoryTenantContext;
  let replica: InMemoryTenantContext;

  beforeEach(() => {
    primary = in_memory_tenant_context(TENANT);
    replica = in_memory_tenant_context(TENANT);
  });

  it('copies every contacts and calendar snapshot of the mailbox, objects before manifests', async () => {
    seed(primary, ALL);

    const results = await replication_service(primary, ALL).replicate_mailbox(TENANT, MAILBOX, [
      target_over(replica, 'offsite'),
    ]);

    expect(results.map((r) => r.snapshot_id)).toEqual([
      'ct-snap-1-a',
      'ct-snap-2-a',
      'cal-snap-1-a',
    ]);
    expect(results.every((r) => r.status === ReplicationStatus.COMPLETED)).toBe(true);
    expect(workload_keys(replica)).toEqual(workload_keys(primary));
    for (const key of workload_keys(primary)) expect(replica.raw(key)).toEqual(primary.raw(key));
    expect(
      results.every((r) => r.source_manifest_checksum === r.replicated_manifest_checksum),
    ).toBe(true);
  });

  it('records a replication status for each copied snapshot on the primary', async () => {
    seed(primary, ALL);

    await replication_service(primary, ALL).replicate_mailbox(TENANT, MAILBOX, [
      target_over(replica, 'offsite'),
    ]);

    const records = primary.keys().filter((key) => key.startsWith('_meta/replication/'));
    expect(records).toEqual([
      `_meta/replication/${MAILBOX}/cal-snap-1-a/offsite.json`,
      `_meta/replication/${MAILBOX}/ct-snap-1-a/offsite.json`,
      `_meta/replication/${MAILBOX}/ct-snap-2-a/offsite.json`,
    ]);
  });

  it('copies nothing on a rerun once the target holds every snapshot', async () => {
    seed(primary, ALL);
    const service = replication_service(primary, ALL);
    const targets = [target_over(replica, 'offsite')];
    await service.replicate_mailbox(TENANT, MAILBOX, targets);
    const after_first = replica.keys();

    const rerun = await service.replicate_mailbox(TENANT, MAILBOX, targets);

    expect(rerun).toEqual([]);
    expect(replica.keys()).toEqual(after_first);
  });

  it('leaves a snapshot whose object fails without a manifest, and still copies the others', async () => {
    seed(primary, ALL);
    primary.remove(CONTACTS[0]!.object_keys[1]!);

    const results = await replication_service(primary, ALL).replicate_mailbox(TENANT, MAILBOX, [
      target_over(replica, 'offsite'),
    ]);

    const failed = results.find((r) => r.snapshot_id === 'ct-snap-1-a')!;
    expect(failed.objects_failed).toBe(1);
    expect(failed.status).not.toBe(ReplicationStatus.COMPLETED);
    expect(replica.raw(CONTACTS[0]!.manifest_key)).toBeUndefined();
    // Each contacts snapshot is whole on its own, so a failed one holds back no newer one.
    expect(replica.raw(CONTACTS[1]!.manifest_key)).toBeDefined();
    expect(replica.raw(CALENDAR[0]!.manifest_key)).toBeDefined();
  });

  it('reports an unreadable source manifest as failed instead of skipping it silently', async () => {
    seed(primary, ALL);
    const damaged = new Set([CALENDAR[0]!.manifest_key]);

    const results = await replication_service(primary, ALL, damaged).replicate_mailbox(
      TENANT,
      MAILBOX,
      [target_over(replica, 'offsite')],
    );

    const failed = results.find((r) => r.snapshot_id === 'cal-snap-1-a')!;
    expect(failed.status).toBe(ReplicationStatus.FAILED);
    expect(failed.errors[0]).toContain(CALENDAR[0]!.manifest_key);
    expect(replica.raw(CALENDAR[0]!.manifest_key)).toBeUndefined();
    expect(replica.raw(CONTACTS[1]!.manifest_key)).toBeDefined();
  });

  it('copies no other mailbox, including one whose id starts with this one', async () => {
    const other = [contacts_snapshot('mbx-10', 3), calendar_snapshot('mbx-10', 3)];
    seed(primary, [...ALL, ...other]);

    await replication_service(primary, [...ALL, ...other]).replicate_mailbox(TENANT, MAILBOX, [
      target_over(replica, 'offsite'),
    ]);

    expect(workload_keys(replica).some((key) => key.includes('mbx-10'))).toBe(false);
  });

  it('opens the target for no contacts or calendar copy when the mailbox has none', async () => {
    const target = target_over(replica, 'offsite');

    const results = await replication_service(primary, []).replicate_mailbox(TENANT, MAILBOX, [
      target,
    ]);

    expect(results).toEqual([]);
    // The one opening is the Outlook pass, which checks the target key even with nothing to copy.
    expect(target.create_context).toHaveBeenCalledTimes(1);
  });
});
