/**
 * Markdown sections on what was injected and requested, the graph-tap comparison block, and the
 * method notes.
 */
import { code, escape_cell, render_table } from './markdown-table.mjs';
import { format_bytes, format_mix, format_ms, format_pct } from './report-format.mjs';

const SHAPE_LIMIT = 15;
const COMPARE_SHAPE_LIMIT = 10;
const COMPARE_LIST_LIMIT = 8;

function latency_cells(l) {
  return l.count ? `${format_ms(l.p50)} / ${format_ms(l.p95)} / ${format_ms(l.max)}` : 'n/a';
}

/** The "what was injected" section. */
export function render_injected_section(model) {
  const inj = model.injected;
  const n = model.requested.totals.requests;
  const by_fault = inj.by_fault.map((f) => [
    code(f.fault_id),
    escape_cell(f.category + (f.category_source === 'journal' ? '' : '*')),
    String(f.applied),
    `${f.from_profile} / ${f.from_outage} / ${f.from_replay}`,
    String(f.skipped),
    escape_cell(format_mix(f.services, 4)),
    escape_cell(format_mix(f.delivered_mix, 4)),
  ]);
  const skipped = inj.skipped.map((s) => [
    code(s.fault_id),
    escape_cell(s.reason),
    String(s.count),
  ]);
  return [
    '## What was injected',
    '',
    `${inj.applied_total} faults applied to ${n} requests (${format_pct(inj.applied_total, n)}). By category: ${escape_cell(format_mix(inj.by_category))}. By service: ${escape_cell(format_mix(inj.by_service))}.`,
    '',
    render_table(
      [
        'Fault',
        'Category',
        'Applied',
        'Profile / outage / replay',
        'Skipped',
        'Services',
        'Delivered',
      ],
      by_fault,
      { limit: 25, align: ['', '', 'right', 'right', 'right', '', ''], noun: 'faults' },
    ),
    ...(inj.by_fault.some((f) => f.category_source !== 'journal')
      ? ["`*` category from the report's fallback table, not from the journal.\n"]
      : []),
    'Planned mutations that were not applied (the client received the real response):',
    '',
    render_table(['Fault', 'Reason', 'Count'], skipped, { align: ['', '', 'right'] }),
  ].join('\n');
}

/** The "what was requested" section. */
export function render_requested_section(model) {
  const r = model.requested;
  const services = r.services.map((s) => [
    escape_cell(s.service),
    String(s.requests),
    String(s.faulted),
    String(s.failures),
    escape_cell(format_mix(s.kinds, 4)),
  ]);
  const shapes = r.shapes.map((s) => [
    code(`${s.method} ${s.url}`),
    String(s.count),
    String(s.faulted),
    escape_cell(format_mix(s.delivered_mix, 4)),
    latency_cells(s.latency_unfaulted),
    latency_cells(s.latency_faulted),
  ]);
  return [
    '## What was requested',
    '',
    `${r.totals.requests} requests in ${r.totals.distinct_shapes} shapes over ${format_ms(r.totals.span_ms)}.`,
    '',
    render_table(['Service', 'Requests', 'Faulted', 'Failed', 'Kinds'], services, {
      align: ['', 'right', 'right', 'right', ''],
    }),
    '| Status mix | |',
    '| --- | --- |',
    `| Upstream answered | ${escape_cell(format_mix(r.upstream_mix, 10))} |`,
    `| Client received | ${escape_cell(format_mix(r.delivered_mix, 10))} |`,
    '',
    `Latency p50 / p95 / max: unfaulted ${latency_cells(r.latency.unfaulted)}, faulted ${latency_cells(r.latency.faulted)}. Faulted latency includes instant synthetic errors and deliberate stalls.`,
    '',
    render_table(
      [
        'Request shape',
        'Count',
        'Faulted',
        'Delivered',
        'Unfaulted p50 / p95 / max',
        'Faulted p50 / p95 / max',
      ],
      shapes,
      { limit: SHAPE_LIMIT, align: ['', 'right', 'right', '', '', ''], noun: 'shapes' },
    ),
  ].join('\n');
}

function compare_block_lines(model) {
  const c = model.compare;
  const t = model.requested.totals;
  const lines = [
    'GRAPH TAP SUMMARY  (outagesoft-365 journal)',
    `${t.requests} requests over ${(t.span_ms / 1000).toFixed(1)}s · tx ${format_bytes(t.req_bytes)} · rx ${format_bytes(t.bytes)}`,
    `status: ${format_mix(c.by_status, 20)}`,
    '',
    `REQUEST SHAPES (${c.shapes.length})`,
  ];
  for (const s of c.shapes.slice(0, COMPARE_SHAPE_LIMIT)) {
    lines.push(`${String(s.count).padStart(5)}  ${s.method.padEnd(6)} ${s.url}`);
    lines.push(
      `         ${format_mix(s.statuses, 20)} · p50 ${s.ms.p50}ms p95 ${s.ms.p95}ms max ${s.ms.max}ms${s.rx ? ` · rx ${format_bytes(s.rx)}` : ''}${s.tx ? ` · tx ${format_bytes(s.tx)}` : ''}`,
    );
  }
  if (c.shapes.length > COMPARE_SHAPE_LIMIT)
    lines.push(`  (+${c.shapes.length - COMPARE_SHAPE_LIMIT} more shapes in report.json)`);
  if (c.throttling.length) {
    lines.push('', 'THROTTLING');
    for (const th of c.throttling.slice(0, COMPARE_LIST_LIMIT)) {
      const ra = th.retry_after_s;
      lines.push(
        `${String(th.count).padStart(5)}  ${th.key}${ra.length ? `\n         retry-after ${ra.join(',')}s (max ${ra[ra.length - 1]}s)` : ''}`,
      );
    }
  }
  if (c.errors.length) {
    lines.push('', 'ERRORS');
    for (const e of c.errors.slice(0, COMPARE_LIST_LIMIT)) {
      const shown = e.urls.slice(0, 2);
      lines.push(
        `${String(e.count).padStart(5)}  ${e.code}`,
        `         on ${shown.join(' | ')}${e.urls.length > 2 ? ` (+${e.urls.length - 2} more)` : ''}`,
      );
    }
  }
  if (c.slowest.length && c.slowest[0].ms > 1000) {
    lines.push('', 'SLOWEST');
    for (const s of c.slowest)
      lines.push(`${String(s.ms).padStart(5)}ms  ${s.status} ${s.method} ${s.url}`);
  }
  return lines;
}

/** The graph-tap compatible block for laying a simulated run beside a real capture. */
export function render_compare_section(model) {
  return [
    '## Compare with real behaviour',
    '',
    'The same figures `graph-tap summary` prints, from what the client received, so this run can be laid beside a graph-tap capture of a real incident. Status keys follow graph-tap: `failed` means no status arrived, `503+failed` means a status arrived and the body did not finish. Transport failures are named by the error text the relay recorded for the client side of the exchange, falling back to the relay outcome (`reset`, `no_response`) for journals that predate it. Latencies are measured at the relay.',
    '',
    '```text',
    ...compare_block_lines(model),
    '```',
    '',
  ].join('\n');
}

/** The method notes and input data quality. */
export function render_method_section(model) {
  const i = model.input;
  const reasons = Object.entries(i.malformed_reasons)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  const quality = [
    `Journal lines read: ${i.lines} (${i.attempts} requests, ${i.blank} blank, ${i.malformed} unreadable${reasons ? `: ${reasons}` : ''}, ${i.relay_errors} relay errors).`,
    `Records with identity_key: ${i.with_identity_key}, with cursor: ${i.with_cursor}, with idempotent: ${i.with_idempotent}.`,
    `Arrival reordering: peak ${i.ordering?.peak_buffered ?? 0} records buffered, ${i.ordering?.late ?? 0} arrived too late to order.`,
  ];
  if (i.relay_error_samples.length)
    quality.push(`Relay error samples: ${i.relay_error_samples.map(code).join(', ')}.`);
  return [
    '## Method and caveats',
    '',
    ...model.caveats.map((c) => `- ${c}`),
    '',
    ...quality.map((q) => `- ${q}`),
    '',
  ].join('\n');
}
