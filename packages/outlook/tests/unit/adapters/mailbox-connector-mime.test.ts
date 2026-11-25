import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { Container } from 'inversify';
import { GRAPH_CLIENT_TOKEN } from '@wisecom/atlas-m365-graph';
import { MimeUnavailableError } from '@wisecom/atlas-types';
import { GraphMailboxConnector } from '@/adapters/graph-mailbox-connector.adapter';

interface GraphError {
  statusCode: number;
  code: string;
}

function graph_error(status: number, code: string): GraphError {
  return { statusCode: status, code };
}

interface MimeConnectorHarness {
  readonly connector: GraphMailboxConnector;
  readonly api: ReturnType<typeof vi.fn>;
  readonly header: ReturnType<typeof vi.fn>;
  readonly response_type: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
}

function create_harness(get_impl: () => Promise<unknown>): MimeConnectorHarness {
  const get = vi.fn(get_impl);
  const response_type = vi.fn();
  const header = vi.fn();
  const api = vi.fn();
  const chain = { header, responseType: response_type, get, select: vi.fn(), top: vi.fn() };
  header.mockReturnValue(chain);
  response_type.mockReturnValue(chain);
  chain.select.mockReturnValue(chain);
  chain.top.mockReturnValue(chain);
  api.mockReturnValue(chain);

  const container = new Container();
  container.bind(GRAPH_CLIENT_TOKEN).toConstantValue({ api });
  container.bind(GraphMailboxConnector).toSelf();

  return { connector: container.get(GraphMailboxConnector), api, header, response_type, get };
}

const MIME = Buffer.from(
  'Received: from mail.example.com\r\nAuthentication-Results: spf=pass\r\n\r\nbody\r\n',
);

describe('GraphMailboxConnector.fetch_mime', () => {
  it('returns the original MIME bytes from /$value', async () => {
    const harness = create_harness(async () => new Response(MIME));

    const result = await harness.connector.fetch_mime('t', 'owner-1', 'msg-1');

    expect(result).toBeInstanceOf(Buffer);
    expect(Buffer.compare(result as Buffer, MIME)).toBe(0);
    expect(harness.api).toHaveBeenCalledWith('/users/owner-1/messages/msg-1/$value');
  });

  it('requests immutable IDs and raw bytes', async () => {
    const harness = create_harness(async () => new Response(MIME));

    await harness.connector.fetch_mime('t', 'owner-1', 'msg-1');

    expect(harness.header).toHaveBeenCalledWith('Prefer', 'IdType="ImmutableId"');
    expect(harness.response_type).toHaveBeenCalledWith('raw');
  });

  it('asks again when $value answers 200 with an empty body (issue #848)', async () => {
    let calls = 0;
    const harness = create_harness(async () => new Response(++calls === 1 ? '' : MIME));

    vi.useFakeTimers();
    try {
      const attempt = harness.connector.fetch_mime('t', 'owner-1', 'msg-1');
      await vi.advanceTimersByTimeAsync(2_000);

      expect(Buffer.compare((await attempt) as Buffer, MIME)).toBe(0);
      expect(harness.get).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects instead of resolving zero bytes when every body comes back empty', async () => {
    const harness = create_harness(async () => new Response(''));

    vi.useFakeTimers();
    try {
      const attempt = harness.connector.fetch_mime('t', 'owner-1', 'msg-1');
      const assertion = expect(attempt).rejects.toThrow(
        'Graph returned an empty MIME body on 3 attempts',
      );
      await vi.advanceTimersByTimeAsync(6_000);
      await assertion;
      expect(harness.get).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [400, 'ErrorInvalidRequest'],
    [401, 'InvalidAuthenticationToken'],
    [404, 'ErrorItemNotFound'],
  ])(
    'rejects with the Graph error on %i %s instead of resolving no MIME (issue #849)',
    async (status, code) => {
      const refusal = graph_error(status, code);
      const harness = create_harness(() => Promise.reject(refusal as unknown as Error));

      await expect(harness.connector.fetch_mime('t', 'owner-1', 'msg-1')).rejects.toBe(refusal);
      expect(harness.get).toHaveBeenCalledTimes(1);
    },
  );

  it('rethrows access denied instead of silently downgrading to JSON', async () => {
    const harness = create_harness(() =>
      Promise.reject(graph_error(403, 'ErrorAccessDenied') as unknown as Error),
    );

    await expect(harness.connector.fetch_mime('t', 'owner-1', 'msg-1')).rejects.toThrow();
  });

  it('rejects with MimeUnavailableError after one request when Exchange cannot convert the item', async () => {
    const harness = create_harness(() =>
      Promise.reject(graph_error(500, 'ErrorMimeContentConversionFailed') as unknown as Error),
    );

    const attempt = harness.connector.fetch_mime('t', 'owner-1', 'poisoned');

    await expect(attempt).rejects.toBeInstanceOf(MimeUnavailableError);
    await expect(attempt).rejects.toMatchObject({ graph_code: 'ErrorMimeContentConversionFailed' });
    expect(harness.get).toHaveBeenCalledTimes(1);
  });

  it('rethrows server failures instead of silently downgrading to JSON', async () => {
    const harness = create_harness(() =>
      Promise.reject(graph_error(500, 'InternalServerError') as unknown as Error),
    );

    vi.useFakeTimers();
    try {
      const attempt = harness.connector.fetch_mime('t', 'owner-1', 'msg-1');
      const assertion = expect(attempt).rejects.toBeTruthy();
      // 12 retries with exponential backoff capped at 300s; skip the wall clock.
      await vi.advanceTimersByTimeAsync(3_600_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
