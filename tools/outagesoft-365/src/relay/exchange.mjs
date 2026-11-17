/**
 * One relayed exchange: the client request, what the relay did with it, and
 * what the client finally received.
 *
 * Every fault and the passthrough path talk to the client through the small
 * set of primitives here, so delivered status, bytes and outcome are counted
 * in exactly one place. Finalisation hangs off the response's `close` event,
 * which Node emits both after a completed response and after the connection
 * dies for any reason. That makes it the single exit for every path: a
 * finished response, an injected reset, a client timeout, a relay bug or a
 * relay shutdown all journal the exchange exactly once, and all clear its
 * timers and abort its upstream request.
 */
import { performance } from 'node:perf_hooks';

/** Creates the exchange record for a request; `on_end(ex)` runs once, after it is finalised. */
export function create_exchange(req, res, facts, on_end) {
  const ex = {
    req,
    res,
    ...facts,
    started: performance.now(),
    req_bytes: 0,
    fault: null,
    forwarded: false,
    upstream: null,
    delivered: { status: null, outcome: null, bytes: 0, total_ms: 0 },
    graph_error: undefined,
    relay_error: undefined,
    forced_outcome: null,
    client_gone: false,
    finalised: false,
    timers: new Set(),
    cleanups: [],
  };
  res.on('close', () => finalise_exchange(ex, on_end));
  return ex;
}

/** Runs cleanups, settles the outcome and hands the exchange to `on_end`, once. */
function finalise_exchange(ex, on_end) {
  if (ex.finalised) return;
  ex.finalised = true;
  ex.client_gone = true;
  for (const timer of ex.timers) {
    clearTimeout(timer.handle);
    timer.resolve(false);
  }
  ex.timers.clear();
  for (const cleanup of ex.cleanups.splice(0)) {
    try {
      cleanup();
    } catch {
      /* a failed cleanup must not stop the exchange from being journaled */
    }
  }
  ex.delivered.total_ms = Math.round(performance.now() - ex.started);
  ex.delivered.outcome =
    ex.forced_outcome ?? (ex.res.writableFinished ? 'complete' : 'client_closed');
  if (ex.delivered.outcome === 'client_closed')
    ex.delivered.error ??= 'client closed the connection';
  on_end(ex);
}

/** Counts a request body chunk and feeds it to the body digest; the body itself is never kept. */
export function count_request_chunk(ex, chunk) {
  ex.req_bytes += chunk.length;
  ex.body_hmac?.update(chunk);
}

/** Registers work to run when the exchange ends (abort an upstream request, release a hold). */
export function on_exchange_end(ex, cleanup) {
  if (ex.finalised) cleanup();
  else ex.cleanups.push(cleanup);
}

/** Waits `ms`; resolves true when the wait completed, false when the exchange ended first. */
export function exchange_sleep(ex, ms) {
  if (ex.client_gone) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = { resolve };
    timer.handle = setTimeout(() => {
      ex.timers.delete(timer);
      resolve(true);
    }, ms);
    ex.timers.add(timer);
  });
}

/** Sends the status line and headers, recording the delivered status and any Retry-After. */
export function write_head(ex, status, headers) {
  if (ex.client_gone || ex.res.headersSent) return;
  ex.res.writeHead(status, headers);
  ex.delivered.status = status;
  const retry_after = headers['retry-after'] ?? headers['Retry-After'];
  if (retry_after !== undefined && /^\d+$/.test(String(retry_after).trim())) {
    ex.delivered.retry_after_s = Number(retry_after);
  }
}

/** Writes a body chunk and waits for backpressure to clear; resolves false once the client is gone. */
export function deliver_chunk(ex, chunk) {
  if (ex.client_gone || chunk.length === 0) return Promise.resolve(!ex.client_gone);
  ex.delivered.bytes += chunk.length;
  if (ex.res.write(chunk)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => {
      ex.res.off('drain', done);
      ex.res.off('close', done);
      resolve(!ex.client_gone);
    };
    ex.res.once('drain', done);
    ex.res.once('close', done);
  });
}

/** Ends the response normally. */
export function end_response(ex, last_chunk) {
  if (ex.client_gone) return;
  if (last_chunk?.length) ex.delivered.bytes += last_chunk.length;
  ex.res.end(last_chunk);
}

/** Sends a complete in-memory response with a correct content-length. */
export function send_response(ex, status, headers, body) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '', 'utf8');
  write_head(ex, status, { ...headers, 'content-length': String(buffer.length) });
  end_response(ex, ex.req.method === 'HEAD' ? undefined : buffer);
}

/**
 * Drops the client connection on purpose and records why.
 *
 * `reset` sends a TCP RST (ECONNRESET at the client); `close` sends a FIN after
 * any queued bytes, which is what a truncated body needs: an RST can make the
 * client's kernel discard the partial body it had already received.
 */
export function drop_connection(ex, outcome, how, reason) {
  if (ex.finalised) return;
  ex.forced_outcome = outcome;
  ex.delivered.error = String(reason).slice(0, 120);
  const socket = ex.req.socket;
  if (how === 'reset' && typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy();
  else socket.destroy();
}

/** Drops the connection only after already-written bytes have been flushed to the socket. */
export function drop_after_flush(ex, outcome, reason) {
  if (ex.client_gone) return;
  ex.forced_outcome = outcome;
  ex.res.write('', () => drop_connection(ex, outcome, 'close', reason));
}

/**
 * Reads a small request body (already capped by its content-length) into
 * memory before planning, counting and digesting it. Sets `ex.body_buffer` and
 * `ex.body_key`; resolves false when the client left before the body ended.
 */
export function read_request_body(ex) {
  return new Promise((resolve) => {
    const chunks = [];
    const req = ex.req;
    req.on('data', (chunk) => {
      count_request_chunk(ex, chunk);
      chunks.push(chunk);
    });
    req.once('end', () => {
      ex.body_buffer = Buffer.concat(chunks);
      ex.body_key = ex.req_bytes > 0 ? ex.body_hmac.digest('hex').slice(0, 16) : null;
      resolve(true);
    });
    req.once('error', () => resolve(false));
    req.once('close', () => resolve(req.readableEnded));
  });
}

/** Reads and discards the request body, counting it; resolves when it ended or the client left. */
export function drain_request(ex) {
  if (ex.body_buffer) return Promise.resolve();
  return new Promise((resolve) => {
    const req = ex.req;
    if (req.complete || req.readableEnded) return resolve();
    req.on('data', (chunk) => count_request_chunk(ex, chunk));
    req.once('end', resolve);
    req.once('error', resolve);
    req.once('close', resolve);
    req.resume();
  });
}
