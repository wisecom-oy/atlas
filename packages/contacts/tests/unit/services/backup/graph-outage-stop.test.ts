/**
 * Issue #881: under a Graph outage that outlasts the retry budget, a contacts backup spends one
 * budget, not one per folder or contact. Folders finished before the outage are committed; the
 * failed folder and those after it keep their previous entries and delta links.
 */

import 'reflect-metadata';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import { GraphUnavailableError } from '@wisecom/atlas-types';
import {
  ATTEMPTS_PER_RETRY_CHAIN,
  GraphOutageFault,
  RETRY_BUDGET_SPAN_MS,
} from '@wisecom/atlas-types/testing/graph-outage-fault';
import {
  contact,
  fake_connector,
  folder,
  memory_cursors,
  memory_manifests,
  tenant_factory_for,
} from '@wisecom/atlas-types/testing/stub-contacts-ports';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';

import { ContactsBackupService } from '@/services/backup/backup.service';

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';

function delta(link: string, ids: string[] = []) {
  return {
    upserted: ids.map((id) => contact(id)),
    removed_ids: [],
    delta_link: link,
    reset: false,
  };
}

/** Backup service over in-memory stores, after a first run of three folders with one contact each. */
async function baseline_harness() {
  const fake = fake_connector();
  const manifests = memory_manifests();
  const cursors = memory_cursors();
  const service = new ContactsBackupService(
    tenant_factory_for(stub_tenant_context().ctx),
    fake.connector,
    manifests,
    cursors,
    stub_owner_leases().leases,
  );
  fake.script.folders = [
    folder('f-default', 'Contacts'),
    folder('f-sub', 'Sub', ['Sub']),
    folder('f-team', 'Team', ['Team']),
  ];
  fake.script.deltas = {
    'f-default': delta('default-1', ['c-default']),
    'f-sub': delta('sub-1', ['c-sub']),
    'f-team': delta('team-1', ['c-team']),
  };
  // No contact carries a photo unless a test says so, so only delta reads reach Graph.
  fake.script.attachment_ids_by_folder = {
    'f-default': new Set(),
    'f-sub': new Set(),
    'f-team': new Set(),
  };
  const run = () => service.backup_contacts('tenant-1', MAILBOX);
  await run();
  return { ...fake, manifests, cursors, run };
}

function contact_ids(entries: readonly { contact_id: string; folder_id: string }[], id: string) {
  return entries
    .filter((entry) => entry.folder_id === id)
    .map((entry) => entry.contact_id)
    .sort();
}

describe('Contacts backup under a whole-run Graph outage (issue #881)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('spends one retry budget, commits finished folders, and rejects with the outage', async () => {
    const h = await baseline_harness();
    h.script.deltas['f-default'] = delta('default-2', ['c-default-new']);
    const graph = new GraphOutageFault();
    const read_delta = h.connector.fetch_contact_delta.bind(h.connector);
    vi.spyOn(h.connector, 'fetch_contact_delta').mockImplementation((...args) =>
      args[2] === 'f-default' ? read_delta(...args) : with_graph_retry(graph.send),
    );

    const run = h.run().catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(RETRY_BUDGET_SPAN_MS);
    const failure = await run;

    expect(failure).toBeInstanceOf(GraphUnavailableError);
    expect(graph.requests).toBe(ATTEMPTS_PER_RETRY_CHAIN);
    const entries = h.manifests.saved.at(-1)?.entries ?? [];
    expect(contact_ids(entries, 'f-default')).toEqual(['c-default', 'c-default-new']);
    expect(contact_ids(entries, 'f-sub')).toEqual(['c-sub']);
    expect(contact_ids(entries, 'f-team')).toEqual(['c-team']);
    expect(h.cursors.saved.at(-1)?.delta_link_by_folder).toEqual({
      'f-default': 'default-2',
      'f-sub': 'sub-1',
      'f-team': 'team-1',
    });
  });
});

describe('Contacts failures and the outage (issue #881)', () => {
  it('fails the whole folder on an outage rather than one error per remaining contact', async () => {
    const h = await baseline_harness();
    h.script.deltas['f-default'] = delta('default-2', ['c-default-new']);
    h.script.deltas['f-sub'] = delta('sub-2', ['c-outage', 'c-two', 'c-three']);
    h.script.attachment_ids_by_folder['f-sub'] = new Set(['c-outage']);
    const read_photo = h.connector.fetch_contact_photo.bind(h.connector);
    vi.spyOn(h.connector, 'fetch_contact_photo').mockImplementation(async (...args) => {
      if (args[3] !== 'c-outage') return read_photo(...args);
      throw new GraphUnavailableError('Microsoft Graph was unavailable after 12 retries', {
        retries: 12,
        elapsed_ms: 1_411_000,
      });
    });

    const result = await h.run();

    expect(result.summary.errors).toEqual([
      'Contacts folder Sub failed: Microsoft Graph was unavailable after 12 retries',
    ]);
    expect(contact_ids(result.snapshot?.entries ?? [], 'f-sub')).toEqual(['c-sub']);
    expect(h.cursors.saved.at(-1)?.delta_link_by_folder['f-sub']).toBe('sub-1');
  });

  it.each([
    ['an ordinary error', () => new Error('photo unavailable')],
    ['a 404', () => Object.assign(new Error('Not Found'), { statusCode: 404 })],
  ])('still records %s against the one contact and stores the rest', async (_name, make_error) => {
    const h = await baseline_harness();
    h.script.deltas['f-sub'] = delta('sub-2', ['c-broken', 'c-two']);
    h.script.attachment_ids_by_folder['f-sub'] = new Set(['c-broken']);
    const read_photo = h.connector.fetch_contact_photo.bind(h.connector);
    vi.spyOn(h.connector, 'fetch_contact_photo').mockImplementation(async (...args) => {
      if (args[3] === 'c-broken') throw make_error();
      return read_photo(...args);
    });

    const result = await h.run();

    expect(result.summary.errors).toHaveLength(1);
    expect(result.summary.errors[0]).toContain('c-broken');
    expect(result.summary.errors[0]).toContain('in Sub failed');
    expect(contact_ids(result.snapshot?.entries ?? [], 'f-sub')).toEqual(['c-sub', 'c-two']);
    expect(h.cursors.saved.at(-1)?.delta_link_by_folder['f-sub']).toBe('sub-1');
  });
});
