/**
 * The short summary printed after a run: header, warnings, every non-PASS verdict, the headline
 * observations, and the report path. Pure, and capped at 25 lines so it never scrolls the child's
 * own output out of view.
 */
import { count_verdicts, verdict_severity } from '../verdicts/correctness-verdicts.mjs';
import { format_ms, format_pct } from './report-format.mjs';
import { child_sentence, run_duration_ms } from './render-markdown.mjs';

/** Upper bound on terminal summary lines, including the report path. */
export const TERMINAL_LINE_BUDGET = 25;
const MAX_LINE_CHARS = 220;
const MAX_WARNINGS = 4;

function clip(text) {
  const plain = text.replaceAll('`', '');
  return plain.length > MAX_LINE_CHARS ? `${plain.slice(0, MAX_LINE_CHARS - 1)}…` : plain;
}

function header_lines(model) {
  const { run, injected, requested } = model;
  const n = requested.totals.requests;
  const replay = run.replay ? ` · replay of ${run.replay.of ?? 'unknown'}` : '';
  return [
    `outagesoft-365 · profile ${run.profile.id} (severity ${run.profile.severity ?? 'n/a'}) · seed ${run.seed ?? 'n/a'} · intensity ${run.intensity ?? 'n/a'} · ${format_ms(run_duration_ms(run))}${replay}`,
    `${n} requests relayed · ${injected.applied_total} ${injected.applied_total === 1 ? 'fault' : 'faults'} injected (${format_pct(injected.applied_total, n)}) · ${injected.skipped_total} skipped · ${child_sentence(run)}`,
  ];
}

function verdict_lines(verdicts) {
  const counts = count_verdicts(verdicts);
  const order = ['FAIL', 'WARN', 'NEEDS EVIDENCE', 'NOT OBSERVED', 'PASS'];
  const tally = order
    .filter((v) => counts[v])
    .map((v) => `${counts[v]} ${v}`)
    .join(', ');
  const rows = verdicts
    .filter((v) => v.verdict !== 'PASS')
    .sort(
      (a, b) => verdict_severity(b.verdict) - verdict_severity(a.verdict) || a.number - b.number,
    )
    .map((v) => `  ${v.verdict.padEnd(14)} ${v.number} ${v.title}: ${v.summary}`);
  return [`verdicts (inferred from traffic): ${tally}`, ...rows];
}

/** Renders the terminal summary, ending with the report path. */
export function render_terminal(model, report_path) {
  const loud_first = [...model.warnings].sort(
    (a, b) => Number(b.level === 'loud') - Number(a.level === 'loud'),
  );
  const warnings = loud_first.slice(0, MAX_WARNINGS).map((w) => `! ${w.text}`);
  if (model.warnings.length > MAX_WARNINGS)
    warnings.push(`! ${model.warnings.length - MAX_WARNINGS} more warnings in the report`);
  const body = [
    ...header_lines(model),
    ...warnings,
    ...verdict_lines(model.verdicts),
    ...model.observations.map((o) => `- ${o}`),
  ].map(clip);
  const room = TERMINAL_LINE_BUDGET - 1;
  const lines = body.length > room ? [...body.slice(0, room - 1), '(more in the report)'] : body;
  return [...lines, `report: ${report_path}`].join('\n');
}
