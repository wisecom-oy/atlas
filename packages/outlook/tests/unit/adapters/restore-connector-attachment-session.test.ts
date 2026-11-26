/**
 * Issue #891. An attachment of 3 MiB or more goes through an upload session, whose final chunk
 * creates the attachment. Its chunk PUTs ran under the default retry policy without the attempt
 * signal, so the final chunk was sent up to 13 times after a 5xx or a timeout, and a timed-out PUT
 * kept running beside its retry.
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
import { GraphRestoreConnector } from '@/adapters/graph-restore-connector.adapter';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const OWNER = 'user@example.com';
const SESSION_URL = 'https://upload.example.com/session-1';
const MIB = 1024 * 1024;
/** Graph's chunk size for the adapter: 13 × 320 KiB. */
const CHUNK = 13 * 320 * 1024;
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
    { record_headers: true, record_signal: true },
  );
  const connector = new GraphRestoreConnector(graph.client as unknown as Client);
  const chunk_puts = (): GraphCall[] => graph.calls.filter((call) => call.method === 'put');
  return { connector, calls: graph.calls, chunk_puts };
}

/** Adds an attachment of `bytes` and settles once `ms` of fake time has passed. */
async function add_attachment(
  connector: GraphRestoreConnector,
  bytes: number,
  ms = 600_000,
): Promise<unknown> {
  const outcome = connector
    .add_attachment('t', OWNER, 'msg-1', {
      name: 'Report.docx',
      content_type: 'application/octet-stream',
      content: Buffer.alloc(bytes, 1),
      is_inline: false,
    })
    .then(
      () => 'added',
      (err: unknown) => err,
    );
  await vi.advanceTimersByTimeAsync(ms);
  return outcome;
}

/** A 503 carrying Retry-After, the form throttling takes. */
function throttled(status: number): Error {
  return Object.assign(graph_error(status, 'Throttled'), { headers: { 'retry-after': '1' } });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GraphRestoreConnector large attachment, final chunk (issue #891)', () => {
  it.each([
    ['500', graph_error(500, 'InternalServerError')],
    ['502', graph_error(502, 'BadGateway')],
    ['504', graph_error(504, 'GatewayTimeout')],
    ['503 without Retry-After', graph_error(503, 'ServiceUnavailable')],
  ])('sends a final chunk answered %s once and reports an unknown outcome', async (_l, err) => {
    const { connector, chunk_puts } = session_with([err, {}]);

    const outcome = await add_attachment(connector, 3.5 * MIB);

    expect(chunk_puts()).toHaveLength(1);
    expect(outcome).toBeInstanceOf(UploadCommitUnknownError);
    expect((outcome as Error).message).toMatch(/^outcome unknown, the attachment may exist/);
  });

  it('aborts a final chunk with no answer at its 60 s deadline and does not send it again', async () => {
    const { connector, chunk_puts } = session_with([HANG, {}]);

    const outcome = await add_attachment(connector, 3.5 * MIB, 61_000);

    expect(chunk_puts()).toHaveLength(1);
    expect(chunk_puts()[0]?.signal?.aborted).toBe(true);
    expect(outcome).toBeInstanceOf(UploadCommitUnknownError);
  });

  it('reports a final chunk whose connection reset as an unknown outcome', async () => {
    const reset = Object.assign(new Error('fetch failed'), { code: 'TypeError' });
    const { connector, chunk_puts } = session_with([reset, {}]);

    const outcome = await add_attachment(connector, 3.5 * MIB);

    expect(chunk_puts()).toHaveLength(1);
    expect(outcome).toBeInstanceOf(UploadCommitUnknownError);
  });

  it.each([
    ['429', throttled(429)],
    ['503 with Retry-After', throttled(503)],
  ])('sends the final chunk again after a %s', async (_label, err) => {
    const { connector, chunk_puts } = session_with([err, {}]);

    expect(await add_attachment(connector, 3.5 * MIB, 10_000)).toBe('added');
    expect(chunk_puts()).toHaveLength(2);
  });

  it('opens the session with the attempt signal', async () => {
    const { connector, calls } = session_with([{}]);

    await add_attachment(connector, 3.5 * MIB, 1_000);

    expect(calls[0]?.url).toMatch(/createUploadSession$/);
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('GraphRestoreConnector large attachment, intermediate chunk (issue #891)', () => {
  it('sends an intermediate chunk again after a 500', async () => {
    const { connector, chunk_puts } = session_with([graph_error(500, 'InternalServerError'), {}]);

    expect(await add_attachment(connector, 5 * MIB, 10_000)).toBe('added');
    expect(chunk_puts().map((call) => call.headers?.['Content-Range'])).toEqual([
      `bytes 0-${CHUNK - 1}/${5 * MIB}`,
      `bytes 0-${CHUNK - 1}/${5 * MIB}`,
      `bytes ${CHUNK}-${5 * MIB - 1}/${5 * MIB}`,
    ]);
  });

  it('aborts a timed-out intermediate chunk before its retry is sent', async () => {
    const { connector, chunk_puts } = session_with([HANG, {}, {}]);
    const outcome = add_attachment(connector, 5 * MIB, 0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(chunk_puts()).toHaveLength(1);
    expect(chunk_puts()[0]?.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await outcome).toBe('added');
    expect(chunk_puts()).toHaveLength(3);
  });
});
