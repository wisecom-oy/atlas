/**
 * Small statistics used throughout the report: a bounded latency histogram and list summaries.
 *
 * Latencies are recorded for every request, so storing each value would make memory grow with the
 * journal. The histogram keeps exact milliseconds below one second and rounds to at most 1 % above
 * it, which is finer than any decision the report supports and keeps memory proportional to the
 * number of distinct buckets. The maximum is tracked exactly.
 */

function latency_bucket(ms) {
  if (ms < 1000) return Math.round(ms);
  if (ms < 10_000) return Math.round(ms / 10) * 10;
  if (ms < 100_000) return Math.round(ms / 100) * 100;
  return Math.round(ms / 1000) * 1000;
}

/** Creates an empty latency histogram. */
export function create_histogram() {
  return { count: 0, max: null, buckets: new Map() };
}

/** Adds one latency in milliseconds to a histogram. */
export function add_to_histogram(histogram, ms) {
  const bucket = latency_bucket(ms);
  histogram.count += 1;
  histogram.max = histogram.max === null ? ms : Math.max(histogram.max, ms);
  histogram.buckets.set(bucket, (histogram.buckets.get(bucket) ?? 0) + 1);
}

/** Percentile of a histogram using the nearest-rank method graph-tap uses, or null when empty. */
export function histogram_percentile(histogram, p) {
  if (!histogram.count) return null;
  const rank = Math.min(histogram.count - 1, Math.floor(histogram.count * p));
  let seen = 0;
  for (const bucket of [...histogram.buckets.keys()].sort((a, b) => a - b)) {
    seen += histogram.buckets.get(bucket);
    if (seen > rank) return bucket;
  }
  return histogram.max;
}

/** `{ count, p50, p95, max }` of a histogram, with nulls when it is empty. */
export function summarise_histogram(histogram) {
  return {
    count: histogram.count,
    p50: histogram_percentile(histogram, 0.5),
    p95: histogram_percentile(histogram, 0.95),
    max: histogram.max,
  };
}

/** Median of a list of numbers, or null when empty. */
export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** `{ count, min, median, max }` of a list of numbers, with nulls when it is empty. */
export function summarise_list(values) {
  if (!values.length) return { count: 0, min: null, median: null, max: null };
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { count: values.length, min, median: median(values), max };
}

/** Increments a count in a Map. */
export function bump(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

/** Map entries sorted by count descending, then key, as `[{ key, count }]`. */
export function ranked_counts(map) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([key, count]) => ({ key, count }));
}
