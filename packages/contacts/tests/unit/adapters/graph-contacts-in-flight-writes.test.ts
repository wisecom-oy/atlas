/**
 * Issue #879: the first Ctrl+C aborted a contact or contact folder create that was already on the
 * wire, though Graph may have committed it. Outlook and drive restores let such a write finish, as
 * `docs/operations/reliability.md` promises for every restore. Contacts writes now do too, while the
 * waits before a send still end on the first Ctrl+C.
 */
import type { Client } from '@microsoft/microsoft-graph-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import {
  graph_error,
  stub_graph_client,
  type GraphCall,
} from '@wisecom/atlas-types/testing/stub-graph-client';
import { create_contact_folder } from '@/adapters/graph-contacts-folders';
import { create_contact, upload_contact_photo } from '@/adapters/graph-contacts-items';

const MAILBOX = 'user@example.com';
const CANCEL = new Error('Run interrupted by Ctrl+C');

/** A mailbox that answers every write after 3 s, recording each one. */
function slow_mailbox(): { client: Client; calls: GraphCall[] } {
  const graph = stub_graph_client(
    () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ id: 'new-1', displayName: 'Sub' }), 3_000);
      }),
  );
  return { client: graph.client as unknown as Client, calls: graph.calls };
}

/** Starts `write` under a run signal, presses Ctrl+C 1 s in, and settles it. */
async function cancelled_one_second_in(write: () => Promise<unknown>): Promise<unknown> {
  const controller = new AbortController();
  const outcome = run_with_abort_signal(controller.signal, write).then(
    (value) => ({ value }),
    (err: unknown) => err,
  );
  await vi.advanceTimersByTimeAsync(1_000);
  controller.abort(CANCEL);
  await vi.advanceTimersByTimeAsync(3_000);
  return outcome;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Contacts restore writes on the wire when Ctrl+C lands (issue #879)', () => {
  it('lets a contact create already sent finish and returns its id', async () => {
    const { client, calls } = slow_mailbox();

    const outcome = await cancelled_one_second_in(() =>
      create_contact(client, MAILBOX, 'folder-1', { displayName: 'Marker' }),
    );

    expect(outcome).toEqual({ value: 'new-1' });
    expect(calls).toHaveLength(1);
  });

  it('lets a contact folder create already sent finish', async () => {
    const { client } = slow_mailbox();

    const outcome = await cancelled_one_second_in(() =>
      create_contact_folder(client, MAILBOX, 'parent-1', 'Sub'),
    );

    expect(outcome).toMatchObject({ value: { id: 'new-1' } });
  });

  it('lets a photo upload already sent finish', async () => {
    const { client } = slow_mailbox();

    const outcome = await cancelled_one_second_in(() =>
      upload_contact_photo(client, MAILBOX, 'folder-1', 'contact-1', new Uint8Array([1, 2, 3])),
    );

    expect(outcome).toEqual({ value: undefined });
  });

  it('still ends the Retry-After wait before a create is sent again', async () => {
    const graph = stub_graph_client(() => {
      throw Object.assign(graph_error(429, 'TooManyRequests'), {
        headers: new Headers({ 'retry-after': '360' }),
      });
    });
    const client = graph.client as unknown as Client;

    const outcome = await cancelled_one_second_in(() =>
      create_contact(client, MAILBOX, 'folder-1', { displayName: 'Marker' }),
    );

    expect(outcome).toBe(CANCEL);
    expect(graph.calls).toHaveLength(1);
  });
});
