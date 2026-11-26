/**
 * Issue #891. An event attachment of 3 MiB or more goes through an upload session, whose final
 * chunk creates the attachment. Its chunks ran under the default retry policy without the attempt
 * signal, so the final chunk was sent again after a 5xx or a timeout.
 */
import 'reflect-metadata';
import type { Client } from '@microsoft/microsoft-graph-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadCommitUnknownError } from '@wisecom/atlas-types';
import {
  graph_error,
  stub_graph_client,
  type GraphCall,
} from '@wisecom/atlas-types/testing/stub-graph-client';
import { upload_event_attachment } from '@/adapters/graph-calendar-attachments';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';
const SESSION_URL = 'https://upload.example.com/session-1';
const MIB = 1024 * 1024;
const HANG = Symbol('hang');

/** Rejects with the signal's reason once it fires, as fetch does for a host that never answers. */
function hang(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** A session whose chunk PUTs take the next answer from `puts`, `{}` once they run out. */
function session_with(puts: unknown[]) {
  let put_index = 0;
  const graph = stub_graph_client(
    (call: GraphCall) => {
      if (call.method === 'post') return { uploadUrl: SESSION_URL };
      const answer = puts[put_index++] ?? {};
      if (answer === HANG) return hang(call.signal);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    { record_signal: true },
  );
  const chunk_puts = (): GraphCall[] => graph.calls.filter((call) => call.method === 'put');
  return { client: graph.client as unknown as Client, calls: graph.calls, chunk_puts };
}

/** Uploads an attachment of `bytes` and settles once `ms` of fake time has passed. */
async function upload(client: Client, bytes: number, ms = 600_000): Promise<unknown> {
  const outcome = upload_event_attachment(client, MAILBOX, 'evt-1', {
    name: 'agenda.pdf',
    content_type: 'application/pdf',
    is_inline: false,
    content: Buffer.alloc(bytes, 2),
  }).then(
    () => 'added',
    (err: unknown) => err,
  );
  await vi.advanceTimersByTimeAsync(ms);
  return outcome;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('upload_event_attachment through an upload session (issue #891)', () => {
  it.each([
    ['500', graph_error(500, 'InternalServerError')],
    ['504', graph_error(504, 'GatewayTimeout')],
    ['503 without Retry-After', graph_error(503, 'ServiceUnavailable')],
  ])('sends a final chunk answered %s once and reports an unknown outcome', async (_l, err) => {
    const { client, chunk_puts } = session_with([err, {}]);

    const outcome = await upload(client, 3.5 * MIB);

    expect(chunk_puts()).toHaveLength(1);
    expect(outcome).toBeInstanceOf(UploadCommitUnknownError);
  });

  it('aborts a final chunk with no answer at its deadline and does not send it again', async () => {
    const { client, chunk_puts } = session_with([HANG, {}]);

    const outcome = await upload(client, 3.5 * MIB, 61_000);

    expect(chunk_puts()).toHaveLength(1);
    expect(chunk_puts()[0]?.signal?.aborted).toBe(true);
    expect(outcome).toBeInstanceOf(UploadCommitUnknownError);
  });

  it('sends the final chunk again after a 429', async () => {
    const throttled = Object.assign(graph_error(429, 'TooManyRequests'), {
      headers: { 'retry-after': '1' },
    });
    const { client, chunk_puts } = session_with([throttled, {}]);

    expect(await upload(client, 3.5 * MIB, 10_000)).toBe('added');
    expect(chunk_puts()).toHaveLength(2);
  });

  it('sends an intermediate chunk again after a 502, and aborts a timed-out one first', async () => {
    const { client, chunk_puts } = session_with([graph_error(502, 'BadGateway'), HANG, {}, {}]);
    const outcome = upload(client, 5 * MIB, 0);

    await vi.advanceTimersByTimeAsync(70_000);
    const [first, second, third] = chunk_puts();
    expect(second?.signal?.aborted).toBe(true);
    expect(first?.signal).not.toBe(third?.signal);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await outcome).toBe('added');
    expect(chunk_puts()).toHaveLength(4);
  });

  it('opens the session with the attempt signal', async () => {
    const { client, calls } = session_with([{}]);

    await upload(client, 3.5 * MIB, 1_000);

    expect(calls[0]?.url).toMatch(/createUploadSession$/);
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});
