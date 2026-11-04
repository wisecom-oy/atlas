/**
 * Plain-text rendering of a measured run and of scenario checks.
 */

const MIB = 1024 * 1024;

/**
 * Formats one measured run: per-class server counters with achieved rates, 429s, hosted
 * downloads, and peak memory. Rates are shown in real and simulated (time-scale normalised) units.
 * @param {string} name
 * @param {object} run result of measured_run
 * @returns {string}
 */
export function format_run(name, run) {
  const k = run.time_scale;
  const secs = run.wall_ms / 1000;
  const lines = [
    `${name}: wall ${secs.toFixed(1)} s at time-scale ${k}, ${run.channels} channel(s)`,
  ];
  for (const cls of ['messages', 'default']) {
    const c = run.server.classes[cls];
    const real = c.attempts / secs;
    lines.push(
      `  ${cls}: attempts ${c.attempts}, admitted ${c.admitted}, 429 ${c.throttled}, ` +
        `${real.toFixed(1)} rps real = ${(real / k).toFixed(2)} rps simulated`,
    );
  }
  const throttled = [...run.server.throttled_by_team.entries()].sort((a, b) => b[1] - a[1]);
  lines.push(
    `  hottest team by 429: ${throttled[0] ? `${throttled[0][1]} (${throttled.length} team(s))` : 'none'}`,
  );
  lines.push(
    `  hosted downloads ${run.server.hosted_downloads} (${(run.server.hosted_bytes / MIB).toFixed(2)} MiB)`,
  );
  const routes = [...run.server.routes.entries()].filter(([, n]) => n > 0);
  lines.push(
    `  requests by route: ${routes.map(([name, n]) => `${name} ${n}`).join(', ') || 'none'}`,
  );
  lines.push(
    `  peak RSS ${(run.mem.peak_rss_bytes / MIB).toFixed(0)} MiB, peak heap ${(run.mem.peak_heap_used_bytes / MIB).toFixed(0)} MiB`,
  );
  return lines.join('\n');
}

/**
 * @param {{name: string, ok: boolean, detail?: string}[]} checks
 * @returns {string}
 */
export function format_checks(checks) {
  return checks
    .map((c) => `[${c.ok ? 'PASS' : 'FAIL'}] ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
    .join('\n');
}
