/**
 * Renders compare.md and the compare terminal summary from a comparison result. Pure.
 */
import { code, escape_cell, render_table } from './markdown-table.mjs';
import { plural, was_were } from './report-format.mjs';

const TABLE_LIMIT = 20;
const TERMINAL_SHAPES = 5;

function pages_cell(pages) {
  return pages.length ? [...pages].sort((a, b) => a - b).join(', ') : '';
}

function opening(c) {
  const v = c.volume;
  const lost = c.lost.total
    ? `**${plural(c.lost.total, 'identity', 'identities')} fetched successfully in the baseline ${was_were(c.lost.total)} never fetched successfully in this run** (${c.lost.requested_never_succeeded} requested but always failed, ${c.lost.never_requested} never requested).`
    : 'Every identity the baseline fetched successfully was also fetched successfully in this run.';
  return `${lost} This run made ${v.run_requests} requests against ${v.baseline_requests} in the baseline (${v.extra_requests >= 0 ? '+' : ''}${v.extra_requests}) over ${v.run_identities} distinct identities against ${v.baseline_identities}. Identities are compared by identity_key; only GET requests count as fetches.`;
}

/** Renders compare.md. */
export function render_compare_markdown(c, names) {
  const lost_rows = c.lost.by_shape.map((g) => [
    escape_cell(g.service),
    code(g.shape),
    String(g.count),
    String(g.requested_never_succeeded),
    String(g.never_requested),
    pages_cell(g.pages),
  ]);
  const only_rows = c.only_in_run.by_shape.map((g) => [
    escape_cell(g.service),
    code(g.shape),
    String(g.count),
    String(g.succeeded),
  ]);
  const volume_rows = c.volume.by_service.map((s) => [
    escape_cell(s.service),
    String(s.baseline),
    String(s.run),
    `${s.run - s.baseline >= 0 ? '+' : ''}${s.run - s.baseline}`,
  ]);
  const parts = [
    '# outagesoft-365 compare',
    '',
    `Baseline \`${names.baseline}\`, run \`${names.run}\`.`,
    '',
    opening(c),
    '',
  ];
  if (c.keys_look_unrelated) {
    parts.push(
      '> [!WARNING]',
      '> The two runs share no identity at all. They were probably recorded on different checkouts (different identity keys) or ran different workloads, so the loss figures below are not meaningful.',
      '',
    );
  }
  parts.push(
    '## Fetched in the baseline, never successfully in this run',
    '',
    render_table(
      [
        'Service',
        'Request shape',
        'Identities',
        'Requested, always failed',
        'Never requested',
        'Pages',
      ],
      lost_rows,
      { limit: TABLE_LIMIT, align: ['', '', 'right', 'right', 'right', ''], noun: 'shapes' },
    ),
    '## Only in this run',
    '',
    render_table(['Service', 'Request shape', 'Identities', 'Succeeded'], only_rows, {
      limit: TABLE_LIMIT,
      align: ['', '', 'right', 'right'],
      noun: 'shapes',
    }),
    '## Request volume by service',
    '',
    render_table(['Service', 'Baseline', 'This run', 'Difference'], volume_rows, {
      align: ['', 'right', 'right', 'right'],
    }),
  );
  return parts.join('\n');
}

/** Renders the compare terminal summary, ending with the compare.md path. */
export function render_compare_terminal(c, report_path) {
  const lines = [
    `outagesoft-365 compare · ${c.volume.run_requests} requests against ${c.volume.baseline_requests} in the baseline · ${c.shared_identities} shared identities`,
    c.lost.total
      ? `LOST: ${c.lost.total} identities fetched in the baseline never succeeded here (${c.lost.requested_never_succeeded} always failed, ${c.lost.never_requested} never requested)`
      : 'no loss: every identity fetched in the baseline was fetched successfully here',
  ];
  if (c.keys_look_unrelated)
    lines.push('! the runs share no identity; different checkouts or different workloads');
  for (const g of c.lost.by_shape.slice(0, TERMINAL_SHAPES)) {
    lines.push(
      `  ${String(g.count).padStart(5)}  ${g.service}  ${g.shape}${g.pages.length ? `  pages ${pages_cell(g.pages)}` : ''}`,
    );
  }
  if (c.lost.by_shape.length > TERMINAL_SHAPES)
    lines.push(`  (+${c.lost.by_shape.length - TERMINAL_SHAPES} more shapes)`);
  lines.push(`report: ${report_path}`);
  return lines.join('\n');
}
