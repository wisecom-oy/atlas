/**
 * Renders report.md from the report model: the verdict paragraph, then the correctness verdicts,
 * then sections with tables. Pure: model in, Markdown string out.
 */
import { code, escape_cell, render_table } from './markdown-table.mjs';
import { format_ms, format_offset, format_pct, plural, was_were } from './report-format.mjs';
import { render_outage_section, render_response_section } from './render-markdown-response.mjs';
import {
  render_compare_section,
  render_injected_section,
  render_method_section,
  render_requested_section,
} from './render-markdown-traffic.mjs';

const TIMELINE_BAR_WIDTH = 30;

/** Run duration from the best available source: run.json times, the child, or the journal span. */
export function run_duration_ms(run) {
  return run.duration_ms ?? run.child?.duration_ms ?? run.journal_span_ms ?? null;
}

/** One sentence on how the child ended. */
export function child_sentence(run) {
  if (!run.child)
    return 'The child result was not recorded, so the run was interrupted or the relay was killed.';
  if (run.child.error) return `The command failed to start (${run.child.error}).`;
  const interrupted = run.child.interrupted ? ' after the run was interrupted' : '';
  if (run.child.signal) return `The child was ended by signal ${run.child.signal}${interrupted}.`;
  if (run.child.exit_code === 0) return `The child exited 0${interrupted}.`;
  return `The child exited with code ${run.child.exit_code ?? 'unknown'}${interrupted}.`;
}

function opening_paragraph(model) {
  const { run, injected, requested } = model;
  const n = requested.totals.requests;
  const p = run.profile;
  const replay = run.replay ? ` replaying \`${run.replay.of ?? 'unknown run'}\`` : '';
  const profile = `Profile \`${p.id}\`${replay} (severity ${p.severity ?? 'n/a'}, seed \`${run.seed ?? 'n/a'}\`, intensity ${run.intensity ?? 'n/a'})`;
  const skipped = injected.skipped_total
    ? ` and ${plural(injected.skipped_total, 'planned mutation')} ${was_were(injected.skipped_total)} skipped`
    : '';
  const lines = [
    `${profile} ran for ${format_ms(run_duration_ms(run))} and relayed ${plural(n, 'request')}. ${plural(injected.applied_total, 'fault')} ${was_were(injected.applied_total)} injected (${format_pct(injected.applied_total, n)} of requests)${skipped}. ${child_sentence(run)}`,
  ];
  if (model.observations.length) {
    lines.push('', ...model.observations.map((o) => `- ${escape_cell(o)}`));
  }
  return lines.join('\n');
}

function render_warnings(warnings) {
  if (!warnings.length) return null;
  return warnings
    .map((w) => `> [!${w.level === 'loud' ? 'CAUTION' : 'WARNING'}]\n> ${w.text}\n`)
    .join('\n');
}

function evidence_text(evidence) {
  return Object.entries(evidence)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k.replaceAll('_', ' ')} ${v}`)
    .join(', ');
}

function render_verdicts(verdicts) {
  const rows = verdicts.map((v) => [
    String(v.number),
    escape_cell(v.title),
    `**${v.verdict}**`,
    escape_cell(v.summary) + (v.examples.length ? `<br>${v.examples.map(code).join('<br>')}` : ''),
    escape_cell(evidence_text(v.evidence) || 'none'),
    escape_cell(v.basis),
  ]);
  return [
    '## Correctness verdicts',
    '',
    'Each verdict is inferred from relayed traffic unless its basis says otherwise. NOT OBSERVED means the run gave the client no chance to show the behaviour; NEEDS EVIDENCE means traffic alone cannot judge it.',
    '',
    render_table(['#', 'Check', 'Verdict', 'Finding', 'Evidence', 'Basis'], rows),
  ].join('\n');
}

function describe_child(child) {
  if (!child) return 'not recorded';
  if (child.error) return escape_cell(`failed to start (${child.error})`);
  const parts = [`exit ${child.exit_code ?? 'n/a'}`];
  if (child.signal) parts.push(`signal ${child.signal}`);
  if (child.interrupted) parts.push('interrupted');
  return escape_cell(parts.join(', '));
}

function relay_counts(run, input) {
  const parts = [
    `${run.relayed_requests ?? 'n/a'} counted by the relay, ${input.attempts} in the journal`,
  ];
  if (run.rejected_requests) parts.push(`${run.rejected_requests} rejected for a wrong token`);
  if (run.relay_errors || input.relay_errors)
    parts.push(`${run.relay_errors ?? input.relay_errors} relay errors`);
  return parts.join(', ');
}

function render_run_section(run, input) {
  const outages = run.outages.length
    ? run.outages
        .map(
          (o) =>
            `${o.service} ${format_offset(o.start_ms)} for ${format_ms(o.duration_ms)} (${o.fault})`,
        )
        .join('; ')
    : 'none';
  const child = describe_child(run.child);
  const rows = [
    ['Profile', `${code(run.profile.id)} severity ${run.profile.severity ?? 'n/a'}`],
    ['Seed / intensity', `${code(run.seed ?? 'n/a')} / ${run.intensity ?? 'n/a'}`],
    ['Outages', escape_cell(outages)],
    [
      'Filters',
      escape_cell(
        `services ${run.services_filter?.join(',') ?? 'all'}, faults ${run.faults_filter?.join(',') ?? 'all'}`,
      ),
    ],
    ['Upstream override', run.upstream_override ? 'yes' : 'no'],
    [
      'Started / finished',
      escape_cell(`${run.started_at ?? 'n/a'} / ${run.finished_at ?? 'not finalised'}`),
    ],
    ['Duration', format_ms(run_duration_ms(run))],
    [
      'Command',
      escape_cell(
        run.command
          ? `${run.command.executable ?? 'n/a'} with ${run.command.arg_count ?? 'n/a'} arguments (not recorded)`
          : 'n/a',
      ),
    ],
    ['Child', child],
    [
      'Verify command',
      run.verify
        ? `exit ${run.verify.exit_code ?? 'n/a'} after ${format_ms(run.verify.duration_ms)}`
        : 'not run',
    ],
    [
      'Replay',
      run.replay
        ? escape_cell(
            `of ${run.replay.of}: ${run.replay.applied}/${run.replay.scheduled} applied, ${run.replay.not_encountered} not encountered, ${run.replay.unscheduled_requests} unscheduled`,
          )
        : 'no',
    ],
    ['Relayed requests', relay_counts(run, input)],
    ['Longest injected wait (max hold)', format_ms(run.max_hold_ms)],
    ['Node / undici', escape_cell(`${run.node ?? 'n/a'} / ${run.undici ?? 'n/a'}`)],
  ];
  return ['## Run', '', render_table(['Field', 'Value'], rows)].join('\n');
}

function timeline_bar(b, max_requests) {
  if (!max_requests) return '';
  const width = Math.round((b.requests / max_requests) * TIMELINE_BAR_WIDTH);
  const failed = b.requests ? Math.round((b.failures / b.requests) * width) : 0;
  return 'x'.repeat(failed) + '='.repeat(width - failed);
}

function render_timeline(timeline) {
  const max = Math.max(0, ...timeline.buckets.map((b) => b.requests));
  const head = `${'offset'.padEnd(9)}${'req'.padStart(5)}${'fault'.padStart(7)}${'fail'.padStart(6)}  ${'outage'.padEnd(10)}  requests (x = failed)`;
  const rows = timeline.buckets.map((b) => {
    const outage = b.outages.length ? b.outages.join(',') : '';
    return `${format_offset(b.start_ms).padEnd(9)}${String(b.requests).padStart(5)}${String(b.faults).padStart(7)}${String(b.failures).padStart(6)}  ${outage.padEnd(10)}  ${timeline_bar(b, max)}`;
  });
  return [
    '## Timeline',
    '',
    `Buckets of ${format_ms(timeline.bucket_ms)} from the first relayed request. \`fault\` counts injected faults, \`fail\` counts responses the client could not use, \`outage\` names an active outage window.`,
    '',
    '```text',
    head,
    ...rows,
    '```',
    '',
  ].join('\n');
}

/** Renders the complete report.md text. */
export function render_markdown(model) {
  return [
    '# outagesoft-365 report',
    '',
    opening_paragraph(model),
    '',
    render_warnings(model.warnings),
    render_verdicts(model.verdicts),
    render_run_section(model.run, model.input),
    render_timeline(model.timeline),
    render_outage_section(model),
    render_response_section(model),
    render_injected_section(model),
    render_requested_section(model),
    render_compare_section(model),
    render_method_section(model),
  ]
    .filter((section) => section !== null)
    .join('\n');
}
