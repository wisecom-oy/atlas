/**
 * A scripted `fetch` for upload session tests: each chunk PUT takes the next answer, and every
 * request is recorded with the signal it was given, so a test can tell an aborted PUT from one
 * left running.
 */
import { vi } from 'vitest';
import { LARGE_UPLOAD_CHUNK } from '@/restore/upload-session';

/** A PUT that never answers until its signal fires, as a stalled upload host behaves. */
export const HANG = Symbol('hang');

/** A response, an error for fetch to reject with, or `HANG`. */
export type PutAnswer = Response | Error | typeof HANG;

export interface RecordedRequest {
  readonly method: string;
  readonly range: string | undefined;
  readonly signal: AbortSignal | undefined;
}

interface FetchInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
}

/** A source of two chunks, so the first PUT is an intermediate one and the second commits. */
export const TWO_CHUNKS = Buffer.alloc(LARGE_UPLOAD_CHUNK + 100, 3);
export const FIRST_RANGE = `bytes 0-${LARGE_UPLOAD_CHUNK - 1}/${LARGE_UPLOAD_CHUNK + 100}`;
export const LAST_RANGE =
  `bytes ${LARGE_UPLOAD_CHUNK}-${LARGE_UPLOAD_CHUNK + 99}/` + `${LARGE_UPLOAD_CHUNK + 100}`;

/** A `fetch failed` whose cause is a reset socket, as undici reports a dropped connection. */
export function connection_reset(): Error {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  });
}

/** Rejects with the signal's reason once it fires, as fetch does. */
function hang(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/**
 * Installs a `fetch` that answers PUTs from `puts` in order (`202` once they run out) and every
 * other request with `other`, and returns the record of every request.
 */
export function stub_upload_host(
  puts: PutAnswer[],
  other: (method: string) => PutAnswer = () => new Response(null, { status: 204 }),
): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  let put_index = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: FetchInit) => {
      const method = init?.method ?? 'GET';
      requests.push({ method, range: init?.headers?.['Content-Range'], signal: init?.signal });
      const answer =
        method === 'PUT'
          ? (puts[put_index++] ?? new Response('{}', { status: 202 }))
          : other(method);
      if (answer === HANG) return hang(init?.signal);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    }),
  );
  return requests;
}

/** The method and range of every chunk PUT, in order. */
export function puts_of(requests: readonly RecordedRequest[]): Array<string | undefined> {
  return requests.filter((request) => request.method === 'PUT').map((request) => request.range);
}

/** Starts `call` and settles it once `ms` of fake time has passed. */
export async function settle_after(call: Promise<unknown>, ms: number): Promise<unknown> {
  const outcome = call.then(
    (value) => value,
    (err: unknown) => err,
  );
  await vi.advanceTimersByTimeAsync(ms);
  return outcome;
}
