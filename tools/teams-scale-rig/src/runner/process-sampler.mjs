/**
 * Samples this process's resident and heap memory on an interval and keeps the peaks.
 * @param {number} [interval_ms] sampling period
 * @returns {{stop: () => {peak_rss_bytes: number, peak_heap_used_bytes: number}}}
 */
export function start_process_sampler(interval_ms = 100) {
  let peak_rss_bytes = 0;
  let peak_heap_used_bytes = 0;
  const sample = () => {
    const { rss, heapUsed } = process.memoryUsage();
    peak_rss_bytes = Math.max(peak_rss_bytes, rss);
    peak_heap_used_bytes = Math.max(peak_heap_used_bytes, heapUsed);
  };
  sample();
  const timer = setInterval(sample, interval_ms);
  return {
    stop() {
      clearInterval(timer);
      sample();
      return { peak_rss_bytes, peak_heap_used_bytes };
    },
  };
}
