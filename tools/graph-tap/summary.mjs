/**
 * Aggregates a graph-tap capture into a report sized for an LLM context window.
 *
 * A backup run makes one request per message, so a raw capture is thousands of
 * near-identical lines. Because `tap.mjs` templates identifiers out of the URL,
 * those lines collapse into a handful of request shapes with counts, status
 * mixes, and timings -- which is what a question about Graph behaviour actually
 * needs. Read the JSONL directly only when a specific request matters.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const file = process.env.GRAPH_TAP_FILE;
if (!file) {
  console.error('summary: set GRAPH_TAP_FILE');
  process.exit(1);
}

const shapes = new Map();
const throttles = new Map();
const errors = new Map();
const totals = { requests: 0, tx: 0, rx: 0, span: 0, by_status: new Map() };
const slowest = [];

const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

function human_bytes(n) {
  if (n < 1024) return `${n}B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)}${units[i]}`;
}

const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    continue;
  }

  totals.requests += 1;
  totals.tx += rec.tx || 0;
  totals.rx += rec.rx || 0;
  totals.span = Math.max(totals.span, (rec.t || 0) + (rec.ms || 0));
  const status_key = rec.failed ? 'failed' : String(rec.status);
  bump(totals.by_status, status_key);

  const key = `${rec.method} ${rec.url}`;
  let shape = shapes.get(key);
  if (!shape) {
    shape = {
      method: rec.method,
      url: rec.url,
      count: 0,
      statuses: new Map(),
      ms: [],
      rx: 0,
      tx: 0,
    };
    shapes.set(key, shape);
  }
  shape.count += 1;
  shape.rx += rec.rx || 0;
  shape.tx += rec.tx || 0;
  shape.ms.push(rec.ms || 0);
  bump(shape.statuses, status_key);

  if (rec.status === 429 || rec.status === 503) {
    const retry = rec.res_headers?.['retry-after'];
    const scope = rec.res_headers?.['x-ms-throttle-scope'];
    const t = throttles.get(key) || { count: 0, retries: new Set(), scopes: new Set() };
    t.count += 1;
    if (retry) t.retries.add(Number(retry));
    if (scope) t.scopes.add(scope);
    throttles.set(key, t);
  }

  // 429/503 are reported under THROTTLING; repeating them here is pure bloat.
  const throttle_status = rec.status === 429 || rec.status === 503;
  if (rec.failed || (!throttle_status && (rec.graph_error || rec.status >= 400))) {
    const code = rec.failed
      ? `transport: ${rec.failed}`
      : `${rec.status} ${rec.graph_error?.code || '(no code)'}`;
    const e = errors.get(code) || { count: 0, sample: rec.graph_error?.message, urls: new Set() };
    e.count += 1;
    e.urls.add(rec.url);
    errors.set(code, e);
  }

  slowest.push({ ms: rec.ms || 0, method: rec.method, url: rec.url, status: status_key });
}

if (!totals.requests) {
  console.log(`No requests captured in ${file}.`);
  process.exit(0);
}

const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const status_mix = (map) =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s, c]) => `${s}×${c}`)
    .join(' ');

console.log(`GRAPH TAP SUMMARY  ${file}`);
console.log(
  `${totals.requests} requests over ${(totals.span / 1000).toFixed(1)}s · ` +
    `tx ${human_bytes(totals.tx)} · rx ${human_bytes(totals.rx)}`,
);
console.log(`status: ${status_mix(totals.by_status)}`);

console.log(`\nREQUEST SHAPES (${shapes.size})`);
const ranked = [...shapes.values()].sort((a, b) => b.count - a.count);
for (const s of ranked) {
  const ms = s.ms.sort((a, b) => a - b);
  console.log(
    `${String(s.count).padStart(5)}  ${s.method.padEnd(6)} ${s.url}\n` +
      `         ${status_mix(s.statuses)} · p50 ${percentile(ms, 0.5)}ms p95 ${percentile(ms, 0.95)}ms max ${ms[ms.length - 1]}ms` +
      `${s.rx ? ` · rx ${human_bytes(s.rx)}` : ''}${s.tx ? ` · tx ${human_bytes(s.tx)}` : ''}`,
  );
}

if (throttles.size) {
  console.log('\nTHROTTLING');
  for (const [key, t] of [...throttles.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const retries = [...t.retries].sort((a, b) => a - b);
    console.log(
      `${String(t.count).padStart(5)}  ${key}` +
        `${retries.length ? `\n         retry-after ${retries.join(',')}s (max ${retries[retries.length - 1]}s)` : ''}` +
        `${t.scopes.size ? ` · scope ${[...t.scopes].join(', ')}` : ''}`,
    );
  }
}

if (errors.size) {
  console.log('\nERRORS');
  for (const [code, e] of [...errors.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`${String(e.count).padStart(5)}  ${code}${e.sample ? ` -- ${e.sample}` : ''}`);
    // Query strings are already shown under REQUEST SHAPES; the path alone
    // identifies the failing call here without repeating kilobytes of it.
    const paths = [...e.urls].map((u) => u.split('?')[0]);
    const shown = [...new Set(paths)].slice(0, 2);
    console.log(
      `         on ${shown.join(' | ')}${paths.length > shown.length ? ` (+${paths.length - shown.length} more)` : ''}`,
    );
  }
}

const top = slowest.sort((a, b) => b.ms - a.ms).slice(0, 3);
if (top.length && top[0].ms > 1000) {
  console.log('\nSLOWEST');
  for (const r of top)
    console.log(`${String(r.ms).padStart(5)}ms  ${r.status} ${r.method} ${r.url}`);
}
