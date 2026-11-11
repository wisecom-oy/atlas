/**
 * Issue #673: the contacts restore read its abort signal only between contacts, so Ctrl+C during a
 * create parked in a Graph Retry-After sat the wait out.
 */

import 'reflect-metadata';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import {
  contact,
  memory_manifests,
  tenant_factory_for,
} from '@wisecom/atlas-types/testing/stub-contacts-ports';
import {
  CONTACTS_MAILBOX,
  CONTACTS_SNAPSHOT,
  contacts_snapshot,
  contacts_target,
  stored_contact,
} from '@wisecom/atlas-types/testing/stub-contacts-snapshots';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';

import { ContactsRestoreService } from '@/services/restore/restore.service';

/** A Graph call throttled with `Retry-After: 360`, which on its own waits six minutes. */
function graph_call_parked_in_retry_wait(): Promise<never> {
  return with_graph_retry(() =>
    Promise.reject({
      statusCode: 429,
      message: 'Too Many Requests',
      headers: new Headers({ 'retry-after': '360' }),
    }),
  );
}

describe('Contacts restore cancelled during a Graph retry wait (issue #673)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ends the create wait within a second and reports an interrupted restore, not a failed contact', async () => {
    const objects: Record<string, Buffer> = {};
    const entries = [
      stored_contact(objects, 'c1', 'src-default', contact('c1')),
      stored_contact(objects, 'c2', 'src-default', contact('c2')),
    ];
    const { ctx } = stub_tenant_context(objects);
    const manifests = memory_manifests();
    await manifests.save(ctx, contacts_snapshot(entries));
    const target = contacts_target();
    const create = vi
      .spyOn(target.connector, 'create_contact')
      .mockImplementation(graph_call_parked_in_retry_wait);
    const service = new ContactsRestoreService(
      tenant_factory_for(ctx),
      target.connector,
      manifests,
    );
    const controller = new AbortController();
    let settled = false;

    const run = service
      .restore_contacts('tenant-1', CONTACTS_MAILBOX, {
        snapshot_id: CONTACTS_SNAPSHOT,
        abort_signal: controller.signal,
      })
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);

    controller.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(settled).toBe(true);
    const result = await run;
    expect(result.interrupted).toBe(true);
    expect(result.errors).toEqual([]);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
