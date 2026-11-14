/**
 * Markdown sections on how the client responded: outage windows and retry behaviour.
 */
import { code, escape_cell, render_table } from './markdown-table.mjs';
import { format_mix, format_ms, format_offset, format_spread, plural } from './report-format.mjs';

const TABLE_LIMIT = 10;

const CONTENT_READING = {
  drop_next_link: ['the rest of the listing was likely never read', 're-requested the page'],
  duplicate_items: ['accepted; duplicates must be handled by the client', 're-requested'],
  shuffle_items: ['accepted; order must not matter to the client', 're-requested'],
  malformed_json: ['gave up or swallowed the parse error', 'retried the parse failure'],
  empty_body_200: ['accepted an empty body or gave up', 'retried the empty body'],
  truncated_body: ['gave up on the truncated body', 'retried the truncated body'],
  batch_inner_429: ['inner 429s were not re-sent on the same URL', 're-sent a $batch'],
};

function window_metric_rows(windows) {
  const col = (fn) => windows.map((w) => escape_cell(fn(w)));
  return [
    ['Source', ...col((w) => w.source)],
    ['Requests to the service', ...col((w) => w.requests)],
    ['Faulted by the outage', ...col((w) => w.outage_faulted)],
    ['Other faults inside', ...col((w) => w.other_faulted)],
    ['Distinct URLs', ...col((w) => w.distinct_urls)],
    [
      'Attempts per URL (min / median / max)',
      ...col((w) =>
        w.attempts_per_url.count
          ? `${w.attempts_per_url.min} / ${w.attempts_per_url.median} / ${w.attempts_per_url.max}`
          : 'n/a',
      ),
    ],
    [
      'Other services during the window',
      ...col((w) => `${w.other_services.requests} requests, ${w.other_services.failures} failed`),
    ],
    [
      'First request after the window',
      ...col((w) =>
        w.first_attempt_after_ms === null ? 'none' : `${format_ms(w.first_attempt_after_ms)} after`,
      ),
    ],
    [
      'Recovery: first usable response',
      ...col((w) =>
        w.first_usable_after_ms === null ? 'none' : `${format_ms(w.first_usable_after_ms)} after`,
      ),
    ],
    [
      'Retry chains active in the window: recovered / still failing / never retried',
      ...col((w) => `${w.chains.recovered} / ${w.chains.unrecovered} / ${w.chains.not_retried}`),
    ],
    [
      'Recovered chains: recovery after the window ended (min / median / max)',
      ...col((w) => format_spread(w.chains.recovered_after_end_ms)),
    ],
  ];
}

/** The outage windows section, or an empty string when the run had none. */
export function render_outage_section(model) {
  const windows = model.outages;
  if (!windows.length) return null;
  const headers = [
    '',
    ...windows.map((w) =>
      escape_cell(
        `${w.service} ${format_offset(w.start_ms)} for ${format_ms(w.duration_ms)} (${w.fault})`,
      ),
    ),
  ];
  const parts = ['## Outage windows', '', render_table(headers, window_metric_rows(windows))];
  for (const w of windows) {
    const rows = w.most_attempted.map((u) => [
      code(u.shape),
      String(u.urls),
      String(u.attempts),
      String(u.max_per_url),
    ]);
    parts.push(
      `Most attempted request shapes during the ${escape_cell(w.service)} window:`,
      '',
      render_table(
        ['Request shape', 'Distinct URLs', 'Attempts', 'Most attempts on one URL'],
        rows,
        { align: ['', 'right', 'right', 'right'] },
      ),
    );
  }
  return parts.join('\n');
}

function render_chains(chains) {
  const rows = chains.by_origin.map((o) => [
    o.injected ? code(o.label) : escape_cell(o.label),
    escape_cell(o.category),
    String(o.chains),
    String(o.recovered),
    String(o.unrecovered),
    String(o.not_retried),
    `${o.retried_counted_by_occurrence} / ${o.recovered + o.unrecovered}`,
    o.attempts_to_clean.count
      ? `${o.attempts_to_clean.median} / ${o.attempts_to_clean.max}`
      : 'n/a',
    format_ms(o.recover_ms.median),
  ]);
  return [
    '### Retry chains by origin',
    '',
    'A chain starts at a response the client could not use and follows later requests for the same request (same URL, and same body digest when the journal records one) until one succeeds. Polling a URL that never failed forms no chain. A retried chain is *counted* when the per-identity `occurrence` rose by exactly one on every attempt, so no other request for that identity came in between; the others are inferred from the URL alone.',
    '',
    render_table(
      [
        'Origin',
        'Category',
        'Chains',
        'Recovered',
        'Still failing at end',
        'Never requested again',
        'Retried chains counted / total',
        'Attempts to recover (median / max)',
        'Time to recover (median)',
      ],
      rows,
      {
        limit: 15,
        align: ['', '', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
        noun: 'origins',
      },
    ),
  ].join('\n');
}

function render_retry_after(ra) {
  if (!ra.advised) return '### Retry-After compliance\n\nNo response carried a Retry-After.\n';
  const tight = ra.tightest
    ? ` Tightest retry: ${format_ms(ra.tightest.gap_ms)} after an advised ${format_ms(ra.tightest.advised_ms)} on ${code(ra.tightest.shape)}.`
    : '';
  const early = ra.early_examples.length
    ? `\n\nEarly retries on: ${ra.early_examples.map(code).join(', ')}.`
    : '';
  return [
    '### Retry-After compliance',
    '',
    `${plural(ra.advised, 'response')} carried a Retry-After (${ra.long_advised_over_300s} over 300 s). **${ra.honoured} honoured**, **${ra.early} early**, ${ra.not_retried} not retried. A retry counts as honouring the header when it arrived no more than ${ra.tolerance_ms} ms before the advised wait had elapsed, measured from the end of the faulted exchange. Observed gaps (min / median / max): ${format_spread(ra.gap_ms)}.${tight}${early}`,
    '',
  ].join('\n');
}

function render_backoff(b) {
  const rows = b.by_step.map((s) => [
    `after failure ${s.after_failure}`,
    String(s.count),
    format_ms(s.median_ms),
  ]);
  return [
    '### Backoff between attempts',
    '',
    `Gaps between attempts in multi-attempt chains (min / median / max): all ${format_spread(b.all_ms)}; chosen by the client without a Retry-After ${format_spread(b.self_chosen_ms)}. ${plural(b.hammering_chains, 'chain')} of ${b.chains_measured_without_retry_after} retried a 429 or 5xx without backing off.`,
    '',
    render_table(['Step (no Retry-After)', 'Gaps', 'Median gap'], rows, {
      limit: 8,
      align: ['', 'right', 'right'],
      noun: 'steps',
    }),
  ].join('\n');
}

function render_timeouts(chains, relations) {
  const closed = chains.timeouts.map((t) => [
    code(t.fault_id),
    String(t.waits_ms.count),
    format_spread(t.waits_ms),
  ]);
  const overlaps = relations.overlaps.map((o) => [
    code(o.fault_id),
    String(o.resent_after_ms.count),
    format_spread(o.resent_after_ms),
  ]);
  return [
    '### Client timeouts',
    '',
    'Exchanges the client closed before the relay finished (`client_closed`), with how long it waited:',
    '',
    render_table(['Fault', 'Closed by client', 'Wait (min / median / max)'], closed, {
      align: ['', 'right', ''],
    }),
    'Inferred timeouts: the same URL re-sent while the previous exchange was still open, with the time from the first send to the re-send:',
    '',
    render_table(['Fault', 'Re-sent while open', 'Re-sent after (min / median / max)'], overlaps, {
      align: ['', 'right', ''],
    }),
  ].join('\n');
}

function render_duplicates(duplicates) {
  const rows = duplicates.list.map((d) => [
    code(d.shape),
    d.fault_id ? code(d.fault_id) : 'none',
    d.same_body ? 'URL and body' : 'URL only',
    String(d.upstream_status ?? 'n/a'),
    d.reached_upstream ? '**yes, likely ran twice**' : 'no',
    d.idempotent === null ? 'unknown' : d.idempotent ? 'yes' : 'no',
    format_ms(d.resent_after_ms),
  ]);
  return [
    '### Duplicate write risk',
    '',
    `Writes re-sent after an ambiguous failure (lost response, no response, truncated body, 504, or a reset after forwarding): ${duplicates.total}. A re-send is matched by the request body digest when the journal records one, so it is the same write sent again; "URL only" means the journal had no digest and a different write to the same URL would look the same.`,
    '',
    render_table(
      [
        'Request shape',
        'Fault',
        'Matched by',
        'Upstream status',
        'Reached upstream',
        'Idempotent',
        'Re-sent after',
      ],
      rows,
      { limit: TABLE_LIMIT, noun: 'writes' },
    ),
  ].join('\n');
}

function render_content(content) {
  const rows = content.map((c) => {
    const reading = CONTENT_READING[c.fault_id] ?? ['not requested again', 're-requested'];
    const verdict = c.not_re_requested
      ? `${c.not_re_requested}: ${reading[0]}`
      : `all ${reading[1]}`;
    return [
      code(c.fault_id),
      escape_cell(c.effect),
      String(c.applied),
      String(c.re_requested),
      escape_cell(verdict),
      format_ms(c.resent_after_ms.median),
    ];
  });
  return [
    '### Content faults',
    '',
    'Whether a damaged or altered response was followed by another request for the same URL. The reading is an inference from the traffic.',
    '',
    render_table(
      ['Fault', 'Effect', 'Applied', 'Re-requested', 'Reading', 'Re-requested after (median)'],
      rows,
      { align: ['', '', 'right', 'right', '', 'right'] },
    ),
  ].join('\n');
}

function render_unresolved(chains) {
  const rows = chains.by_shape.map((s) => [
    code(s.shape),
    escape_cell(s.service),
    String(s.unrecovered),
    String(s.not_retried),
    escape_cell(format_mix(s.labels, 3)),
  ]);
  return [
    '### Requests that never recovered',
    '',
    render_table(
      ['Request shape', 'Service', 'Still failing at end', 'Never requested again', 'Origins'],
      rows,
      { limit: TABLE_LIMIT, align: ['', '', 'right', 'right', ''], noun: 'shapes' },
    ),
  ].join('\n');
}

/** The "how the client responded" section. */
export function render_response_section(model) {
  const { chains, relations } = model.response;
  return [
    '## How the client responded',
    '',
    render_chains(chains),
    render_retry_after(relations.retry_after),
    render_backoff(chains.backoff),
    render_timeouts(chains, relations),
    render_duplicates(relations.duplicates),
    render_content(relations.content),
    render_unresolved(chains),
  ].join('\n');
}
