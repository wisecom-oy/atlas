/**
 * Re-sorts journal records into request arrival order using a bounded buffer.
 *
 * The relay writes a line when an exchange ends, so the file is ordered by end time: a request held
 * for 90 seconds is written after everything that arrived during those 90 seconds. Retry analysis
 * needs arrival order. Sorting the whole journal would hold every record in memory, so records are
 * buffered in a min-heap on arrival time and released once no later line can arrive earlier.
 *
 * A line ending at `end` can only be preceded in arrival by lines whose own exchange lasted longer
 * than the gap. The first pass knows the longest exchange in the journal, so a record is safe to
 * release once the latest end time seen is more than that longest exchange (plus a margin for write
 * jitter) beyond its arrival. Memory is bounded by the requests in flight within that horizon.
 * A record that still arrives after a later one was released is counted, not dropped.
 */

const WRITE_JITTER_MARGIN_MS = 5000;

function before(a, b) {
  return a.t < b.t || (a.t === b.t && a.seq < b.seq);
}

function heap_push(heap, item) {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (!before(heap[i], heap[parent])) break;
    [heap[i], heap[parent]] = [heap[parent], heap[i]];
    i = parent;
  }
}

function heap_pop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      if (left < heap.length && before(heap[left], heap[smallest])) smallest = left;
      if (right < heap.length && before(heap[right], heap[smallest])) smallest = right;
      if (smallest === i) break;
      [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
      i = smallest;
    }
  }
  return top;
}

/**
 * Creates a buffer that calls `on_release(attempt)` in arrival order.
 * `longest_exchange_ms` is the largest `delivered.total_ms` in the journal, known from the first pass.
 */
export function create_arrival_order_buffer(longest_exchange_ms, on_release) {
  const heap = [];
  const horizon = longest_exchange_ms + WRITE_JITTER_MARGIN_MS;
  let latest_end = -Infinity;
  let last_released_t = -Infinity;
  let late = 0;
  let peak = 0;

  function release(item) {
    if (item.t < last_released_t) late += 1;
    last_released_t = Math.max(last_released_t, item.t);
    on_release(item);
  }

  function push(attempt) {
    latest_end = Math.max(latest_end, attempt.t + attempt.total_ms);
    heap_push(heap, attempt);
    peak = Math.max(peak, heap.length);
    while (heap.length && heap[0].t < latest_end - horizon) release(heap_pop(heap));
  }

  function flush() {
    while (heap.length) release(heap_pop(heap));
    return { late, peak_buffered: peak };
  }

  return { push, flush };
}
