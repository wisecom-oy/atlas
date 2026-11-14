/**
 * Transport faults: the connection itself misbehaves.
 *
 * These act on the real client socket, so the client sees the genuine error
 * its HTTP stack produces (undici's "other side closed", ECONNRESET,
 * "terminated"), not a status code pretending to be one.
 */
import {
  drain_request,
  drop_after_flush,
  drop_connection,
  deliver_chunk,
  exchange_sleep,
  write_head,
} from '../exchange.mjs';
import { client_response_headers } from '../upstream-forwarder.mjs';
import {
  buffer_body,
  make_throttle,
  send_buffered_then_rest,
  stream_unchanged,
} from './response-streaming.mjs';

const TRUNCATED_REASON = 'socket closed by relay mid-body';

/** connection_reset: an RST before any response byte. */
export function reset_connection(ex) {
  drop_connection(ex, 'reset', 'reset', 'connection reset by relay before any response');
}

/** no_response: read the request, answer nothing, close after `hold_ms` unless the client gives up first. */
export async function hold_without_response(ex) {
  await drain_request(ex);
  if (await exchange_sleep(ex, ex.fault.params.hold_ms))
    drop_connection(
      ex,
      'no_response',
      'close',
      'socket closed by relay after holding without a response',
    );
}

/** slow_body: the body arrives at `bytes_per_second` for at most `max_ms`, then at full speed. */
export async function deliver_slow_body(ex, up_res, body) {
  const { bytes_per_second, max_ms } = ex.fault.params;
  await stream_unchanged(
    ex,
    up_res.statusCode,
    client_response_headers(up_res),
    body,
    make_throttle(bytes_per_second, max_ms),
  );
}

/** Sends the first `cut` bytes of buffered chunks, then drops the connection. */
async function send_prefix_then_drop(ex, chunks, cut) {
  let remaining = cut;
  for (const chunk of chunks) {
    if (remaining <= 0) break;
    const piece = chunk.subarray(0, remaining);
    remaining -= piece.length;
    if (!(await deliver_chunk(ex, piece))) return;
  }
  drop_after_flush(ex, 'truncated', TRUNCATED_REASON);
}

/** Streams until `cut` bytes were delivered, then drops the connection. */
async function stream_prefix_then_drop(ex, body, cut) {
  let remaining = cut;
  while (remaining > 0) {
    const { value, done } = await body.next();
    if (done) break;
    const piece = value.subarray(0, remaining);
    remaining -= piece.length;
    if (!(await deliver_chunk(ex, piece))) return;
  }
  await body.return();
  drop_after_flush(ex, 'truncated', TRUNCATED_REASON);
}

/**
 * truncated_body: headers and a fraction of the body, then the connection drops.
 *
 * With a content-length the cut is a fraction of it and the body streams. A
 * chunked response has no length to take a fraction of, so it is buffered up
 * to the cap first; past the cap the cut is a fraction of what was buffered.
 */
export async function deliver_truncated(ex, up_res, body) {
  const headers = client_response_headers(up_res);
  const fraction = ex.fault.params.fraction;
  const declared = Number(up_res.headers['content-length']);
  if (Number.isFinite(declared) && up_res.headers['content-length'] !== undefined) {
    if (declared < 2) {
      ex.fault.skipped = 'body too short to truncate';
      return stream_unchanged(ex, up_res.statusCode, headers, body);
    }
    write_head(ex, up_res.statusCode, headers);
    return stream_prefix_then_drop(ex, body, Math.max(1, Math.floor(declared * fraction)));
  }
  const buffered = await buffer_body(body);
  if (buffered.bytes < 2) {
    ex.fault.skipped = 'body too short to truncate';
    return send_buffered_then_rest(ex, up_res.statusCode, headers, buffered, body);
  }
  write_head(ex, up_res.statusCode, headers);
  await send_prefix_then_drop(
    ex,
    buffered.chunks,
    Math.max(1, Math.floor(buffered.bytes * fraction)),
  );
  if (!buffered.done) await body.return();
}

/** lost_response: the upstream answers in full (a write commits), the client gets a reset. */
export async function lose_response(ex, body) {
  for (;;) {
    const { done } = await body.next();
    if (done) break;
  }
  drop_connection(ex, 'reset', 'reset', 'connection reset by relay after the upstream answered');
}
