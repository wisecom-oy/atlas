import { AsyncLocalStorage } from 'node:async_hooks';
import { subscribe } from 'node:diagnostics_channel';
import type { ClientRequest } from 'node:http';
import { performance } from 'node:perf_hooks';

/** Socket queueing and network time accumulated over every attempt of one logical request. */
export interface RequestTiming {
  socket_wait_ms: number;
  network_ms: number;
  connection_reused: boolean;
}

interface AttemptTiming {
  readonly started: number;
  request_created: boolean;
  socket_at?: number;
  connection_reused?: boolean;
}

/**
 * `http.client.request.created` is published synchronously in the `ClientRequest` constructor,
 * before the request can obtain a socket, so a listener attached there sees the moment the
 * connection pool hands one over. The older `http.client.request.start` fires once the body is
 * written, which can be after the socket arrived, so it is no substitute. Added in 22.12.0 and
 * 23.2.0.
 */
const REQUEST_CREATED_CHANNEL = 'http.client.request.created';

const _attempt = new AsyncLocalStorage<AttemptTiming>();
let _subscribed = false;

/** Whether this Node release publishes the channel the socket split depends on. */
export function supports_attempt_timing(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  if (major === 22) return minor >= 12;
  if (major === 23) return minor >= 2;
  return major > 23;
}

/**
 * Times one HTTP attempt and adds its socket wait and network time to `timing`.
 *
 * An attempt that never created a request (it failed while signing or serialising) adds
 * nothing; one that created a request but never obtained a socket spent all of its time queued.
 */
export async function time_attempt<T>(timing: RequestTiming, send: () => Promise<T>): Promise<T> {
  subscribe_once();
  const attempt: AttemptTiming = { started: performance.now(), request_created: false };
  try {
    return await _attempt.run(attempt, send);
  } finally {
    const ended = performance.now();
    if (attempt.socket_at !== undefined) {
      timing.socket_wait_ms += attempt.socket_at - attempt.started;
      timing.network_ms += ended - attempt.socket_at;
      timing.connection_reused = attempt.connection_reused ?? false;
    } else if (attempt.request_created) {
      timing.socket_wait_ms += ended - attempt.started;
    }
  }
}

/**
 * Subscribes on first use, process-wide. Requests created outside an Atlas attempt see no
 * attempt in their async context and are ignored, so other HTTP traffic in the host is untouched.
 * A throwing subscriber surfaces as an uncaught exception in the host, hence the guard.
 */
function subscribe_once(): void {
  if (_subscribed) return;
  _subscribed = true;
  subscribe(REQUEST_CREATED_CHANNEL, (message) => {
    const attempt = _attempt.getStore();
    if (!attempt) return;
    try {
      const { request } = message as { request: ClientRequest };
      attempt.request_created = true;
      request.once('socket', () => {
        attempt.socket_at = performance.now();
        attempt.connection_reused = request.reusedSocket;
      });
    } catch {
      // Timing is diagnostics; losing one attempt's split must not take the host down.
    }
  });
}
