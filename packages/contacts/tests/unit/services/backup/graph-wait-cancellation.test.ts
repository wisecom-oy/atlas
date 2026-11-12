/**
 * Issue #673: the contacts backup read its abort signal only between contacts, so Ctrl+C during a
 * delta read parked in a Graph Retry-After sat the wait out.
 */

import 'reflect-metadata';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import {
  fake_connector,
  memory_cursors,
  memory_manifests,
  tenant_factory_for,
} from '@wisecom/atlas-types/testing/stub-contacts-ports';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';

import { ContactsBackupService } from '@/services/backup/backup.service';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';

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

describe('Contacts backup cancelled during a Graph retry wait (issue #673)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ends the delta read wait within a second and records an interrupted run', async () => {
    const { connector } = fake_connector();
    const cursors = memory_cursors();
    const service = new ContactsBackupService(
      tenant_factory_for(stub_tenant_context().ctx),
      connector,
      memory_manifests(),
      cursors,
      stub_owner_leases().leases,
    );
    vi.spyOn(connector, 'fetch_contact_delta').mockImplementation(graph_call_parked_in_retry_wait);
    const controller = new AbortController();
    let settled = false;

    const run = service
      .backup_contacts('tenant-1', MAILBOX, { abort_signal: controller.signal })
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);

    controller.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(settled).toBe(true);
    const result = await run;
    expect(result.interrupted).toBe(true);
    expect(result.summary.errors).toEqual([]);
    expect(cursors.saved).toEqual([]);
  });
});
