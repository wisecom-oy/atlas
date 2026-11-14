/**
 * out_of_order: a finished upstream response is held back until later
 * responses have overtaken it, so concurrent requests complete in a different
 * order than the upstream produced them.
 *
 * The gate counts completed deliveries across the whole relay. A held
 * response waits until `overtaken_by` more exchanges have completed after it
 * was parked, or until `max_hold_ms` (already capped by --max-hold), whichever
 * comes first. The timeout matters: with no concurrent traffic nothing could
 * ever overtake it, and two held responses would otherwise wait on each other.
 */
import { exchange_sleep } from '../relay/exchange.mjs';
import { client_response_headers } from '../relay/upstream-forwarder.mjs';
import { buffer_body, send_buffered_then_rest } from './response-streaming.mjs';

/** Creates the relay-wide reorder gate. */
export function create_reorder_gate() {
  let delivered = 0;
  const waiters = new Set();
  return {
    /** Counts one completed delivery and releases any hold it satisfies. */
    note_delivered() {
      delivered += 1;
      for (const waiter of waiters) {
        if (delivered >= waiter.target) {
          waiters.delete(waiter);
          waiter.release();
        }
      }
    },
    /** Resolves once `count` further deliveries happened, or `max_ms` passed, or the exchange ended. */
    async hold(ex, count, max_ms) {
      let release;
      const overtaken = new Promise((resolve) => {
        release = resolve;
      });
      const waiter = { target: delivered + count, release };
      waiters.add(waiter);
      await Promise.race([overtaken, exchange_sleep(ex, max_ms)]);
      waiters.delete(waiter);
      release();
    },
  };
}

/** Buffers the whole response, holds it at the gate, then delivers it unchanged. */
export async function deliver_reordered(ex, up_res, body, gate) {
  const buffered = await buffer_body(body);
  if (!buffered.done) {
    ex.fault.skipped = 'response larger than 4 MiB cannot be held';
  } else {
    await gate.hold(ex, ex.fault.params.overtaken_by, ex.fault.params.max_hold_ms);
  }
  await send_buffered_then_rest(
    ex,
    up_res.statusCode,
    client_response_headers(up_res),
    buffered,
    body,
  );
}
