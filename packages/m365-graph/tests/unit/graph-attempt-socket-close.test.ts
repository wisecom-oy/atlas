import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticationProvider } from '@microsoft/microsoft-graph-client';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { create_graph_client } from '@/graph-client.factory';
import { with_graph_retry } from '@/graph-request-error-handler';

/**
 * Issues #888 and #875 over a real socket: a server that accepts the connection and never answers,
 * as a hung Graph backend does. Node's own fetch carries the request, so the test sees what the
 * server sees: whether Atlas closed the connection, and when. An open socket is what kept the
 * process alive after it printed its result.
 */

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const TIMEOUT_MS = 300;
const STATIC_TOKEN: AuthenticationProvider = { getAccessToken: () => Promise.resolve('token') };

/** What the silent server saw of each connection. */
interface Connection {
  readonly opened_at: number;
  closed_at: number | undefined;
}

let server: Server;
const sockets: Socket[] = [];
let connections: Connection[];

/** Waits until `condition` holds, polling every 10 ms, for at most `ms`. */
async function until(condition: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
}

beforeEach(async () => {
  connections = [];
  server = createServer((socket) => {
    const connection: Connection = { opened_at: Date.now(), closed_at: undefined };
    connections.push(connection);
    sockets.push(socket);
    // Read the request, or the client's FIN would never surface as a close.
    socket.resume();
    socket.on('close', () => {
      connection.closed_at = Date.now();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const real_fetch = globalThis.fetch;
  // Graph's host is fixed in the client; the request goes to the silent server instead.
  vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) =>
    real_fetch(`http://127.0.0.1:${port}/v1.0/users/u`, init),
  );
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
});

describe('a request to a server that never answers', () => {
  it('has its connection closed at the attempt timeout, before the retry connects', async () => {
    const client = create_graph_client(STATIC_TOKEN);
    const run = new AbortController();
    const outcome = run_with_abort_signal(run.signal, () =>
      with_graph_retry(() => client.api('/users/u').get(), { timeout_ms: TIMEOUT_MS }),
    ).catch((err: unknown) => err);

    await until(() => connections.length >= 2);
    run.abort(new Error('done'));
    await outcome;

    const [first, second] = connections;
    expect(first?.closed_at).toBeDefined();
    expect(first!.closed_at! - first!.opened_at).toBeLessThan(TIMEOUT_MS + 200);
    expect(second!.opened_at).toBeGreaterThanOrEqual(first!.closed_at!);
  });

  it('has its connection closed at once when the run is cancelled', async () => {
    const client = create_graph_client(STATIC_TOKEN);
    const run = new AbortController();
    const outcome = run_with_abort_signal(run.signal, () =>
      with_graph_retry(() => client.api('/users/u').get()),
    ).catch((err: unknown) => err);
    await until(() => connections.length === 1);

    const cancelled_at = Date.now();
    run.abort(new Error('Run interrupted by Ctrl+C'));
    await outcome;
    await until(() => connections[0]?.closed_at !== undefined);

    expect(connections[0]!.closed_at! - cancelled_at).toBeLessThan(200);
  });
});
