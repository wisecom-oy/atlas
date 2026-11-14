/**
 * Moving an upstream body to the client: streamed, throttled, or buffered up
 * to a cap.
 *
 * Bodies are read through one async iterator per exchange, advanced with
 * explicit `next()` calls. A `for await` loop that breaks would close the
 * iterator and lose the rest of the body, and a fault that buffers part of a
 * response and then decides not to apply must still forward every byte.
 */
import { performance } from 'node:perf_hooks';
import { deliver_chunk, end_response, exchange_sleep, write_head } from '../relay/exchange.mjs';

/** Largest response a fault may hold in memory (mutations, reordering, unknown-length truncation). */
export const BUFFER_CAP_BYTES = 4 * 1024 * 1024;

/** Interval between throttled slices; ten slices per second keeps the rate smooth. */
const THROTTLE_TICK_MS = 100;

/**
 * Reads from `body` until the stream ends or more than `cap` bytes are held.
 * Returns { chunks, bytes, done }; when `done` is false the rest is still in `body`.
 */
export async function buffer_body(body, cap = BUFFER_CAP_BYTES) {
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { value, done } = await body.next();
    if (done) return { chunks, bytes, done: true };
    chunks.push(value);
    bytes += value.length;
    if (bytes > cap) return { chunks, bytes, done: false };
  }
}

/** Delivers one chunk, throttled when `throttle` = { slice, until } is still active. */
async function deliver_maybe_throttled(ex, chunk, throttle) {
  let offset = 0;
  while (offset < chunk.length) {
    if (!throttle || performance.now() >= throttle.until) {
      return deliver_chunk(ex, chunk.subarray(offset));
    }
    // Wait before a slice rather than after it: a wait after the final slice
    // would delay end-of-response although the client already holds every byte.
    if (throttle.sent_any && !(await exchange_sleep(ex, THROTTLE_TICK_MS))) return false;
    throttle.sent_any = true;
    const piece = chunk.subarray(offset, offset + throttle.slice);
    offset += piece.length;
    if (!(await deliver_chunk(ex, piece))) return false;
  }
  return true;
}

/** Delivers whatever remains in `body`, optionally throttled, then ends the response. */
export async function deliver_rest(ex, body, throttle = null) {
  for (;;) {
    const { value, done } = await body.next();
    if (done) break;
    if (!(await deliver_maybe_throttled(ex, value, throttle))) {
      await body.return();
      return;
    }
  }
  end_response(ex);
}

/** Streams an upstream response through unchanged: status, headers, then body. */
export async function stream_unchanged(ex, status, headers, body, throttle = null) {
  write_head(ex, status, headers);
  await deliver_rest(ex, body, throttle);
}

/** Sends already-buffered chunks, then whatever is left in `body`, unchanged. */
export async function send_buffered_then_rest(ex, status, headers, buffered, body) {
  write_head(ex, status, headers);
  for (const chunk of buffered.chunks) {
    if (!(await deliver_chunk(ex, chunk))) return;
  }
  if (buffered.done) end_response(ex);
  else await deliver_rest(ex, body);
}

/** Builds the throttle for slow_body: bytes per tick, active for `max_ms` from now. */
export function make_throttle(bytes_per_second, max_ms) {
  return {
    slice: Math.max(1, Math.floor((bytes_per_second * THROTTLE_TICK_MS) / 1000)),
    until: performance.now() + max_ms,
    sent_any: false,
  };
}
