import { beforeEach, describe, expect, it, vi } from 'vitest';
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
 * Issue #715: `rehydrate --all` and `rehydrate -m` recovered Outlook, OneDrive and SharePoint but
 * never looked under `contacts/` or `calendar/`, and the summary named only Teams as uncovered.
 */
vi.mock('@/services/replication/dek-rehydration-validator', () => ({
  ensure_source_dek_on_primary: vi.fn(async () => undefined),
}));

const FIRST = [contacts_snapshot('mbx-1', 1), calendar_snapshot('mbx-1', 1)];
const SECOND = [contacts_snapshot('mbx-2', 2), calendar_snapshot('mbx-2', 2)];
const ALL = [...FIRST, ...SECOND];

describe('rehydrate with contacts and calendar snapshots on the replica', () => {
  let primary: InMemoryTenantContext;
  let replica: InMemoryTenantContext;

  beforeEach(() => {
    primary = in_memory_tenant_context(TENANT);
    replica = in_memory_tenant_context(TENANT);
    seed(replica, ALL);
  });

  it('--all recovers every mailbox and reports contacts and calendar as their own workloads', async () => {
    const result = await replication_service(primary, ALL).rehydrate_tenant(
      TENANT,
      target_over(replica, 'offsite'),
    );

    expect(result.workloads.map((w) => w.workload)).toEqual([
      'outlook',
      'contacts',
      'calendar',
      'onedrive',
      'sharepoint',
    ]);
    expect(result.unsupported_workloads).toEqual(['teams']);
    expect(workload_keys(primary)).toEqual(workload_keys(replica));
    for (const key of workload_keys(replica)) expect(primary.raw(key)).toEqual(replica.raw(key));
    const by_workload = new Map(result.workloads.map((w) => [w.workload, w.result]));
    expect(by_workload.get('contacts')?.objects_copied).toBe(4);
    expect(by_workload.get('calendar')?.objects_copied).toBe(4);
    expect(result.total.status).toBe(ReplicationStatus.COMPLETED);
  });

  it('writes no replica marker into the primary it recovers', async () => {
    await replication_service(primary, ALL).rehydrate_tenant(TENANT, target_over(replica, 'x'));

    expect(primary.raw('_meta/replica.marker')).toBeUndefined();
  });

  it('-m recovers that mailbox only, folded into one result', async () => {
    const result = await replication_service(primary, ALL).rehydrate_mailbox(
      TENANT,
      'MBX-1',
      target_over(replica, 'offsite'),
    );

    expect(result.status).toBe(ReplicationStatus.COMPLETED);
    expect(result.objects_copied).toBe(4);
    expect(workload_keys(primary).every((key) => key.includes('/mbx-1/'))).toBe(true);
    for (const snapshot of FIRST) expect(primary.raw(snapshot.manifest_key)).toBeDefined();
  });

  it('skips snapshots the primary already holds on a rerun', async () => {
    const service = replication_service(primary, ALL);
    await service.rehydrate_tenant(TENANT, target_over(replica, 'offsite'));

    const rerun = await service.rehydrate_tenant(TENANT, target_over(replica, 'offsite'));

    const by_workload = new Map(rerun.workloads.map((w) => [w.workload, w.result]));
    expect(by_workload.get('contacts')?.objects_copied).toBe(0);
    expect(by_workload.get('contacts')?.objects_skipped).toBe(2);
    expect(by_workload.get('calendar')?.objects_skipped).toBe(2);
  });

  it('fails the workload for an unreadable manifest on the replica, so the run is not complete', async () => {
    const damaged = new Set([SECOND[0]!.manifest_key]);

    const result = await replication_service(primary, ALL, damaged).rehydrate_tenant(
      TENANT,
      target_over(replica, 'offsite'),
    );

    const contacts = result.workloads.find((w) => w.workload === 'contacts')!.result;
    expect(contacts.objects_failed).toBe(1);
    expect(contacts.errors.join('\n')).toContain(SECOND[0]!.manifest_key);
    expect(result.total.status).not.toBe(ReplicationStatus.COMPLETED);
    expect(primary.raw(FIRST[0]!.manifest_key)).toBeDefined();
  });
});
