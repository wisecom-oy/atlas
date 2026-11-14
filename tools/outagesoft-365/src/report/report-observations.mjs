/**
 * The warnings and headline observations at the top of the report.
 *
 * Warnings are about whether the run can be trusted at all (nothing relayed, the child failed, the
 * run was killed, replay diverged, the journal was damaged). Observations are the two or three
 * most important things the client did, ranked so a reader who stops after the first paragraph
 * still learns the main finding.
 */
import { format_ms, format_offset, plural, was_were } from './report-format.mjs';

const MAX_OBSERVATIONS = 3;

function warn(level, code, text) {
  return { level, code, text };
}

function replay_warning(replay) {
  if (!replay) return null;
  const diverged =
    replay.not_encountered || replay.unscheduled_requests || replay.applied !== replay.scheduled;
  if (!diverged) return null;
  return warn(
    'loud',
    'replay_diverged',
    `Replay of \`${replay.of ?? 'unknown run'}\` diverged: ${replay.applied ?? 0} of ${replay.scheduled ?? 0} scheduled faults were applied, ${replay.not_encountered ?? 0} scheduled requests never came and ${replay.unscheduled_requests ?? 0} requests were ones the source run never made. The client's behaviour or the tenant changed since the source run, so this is not an exact reproduction.`,
  );
}

function child_warning(run) {
  const c = run.child;
  if (!c) return null;
  if (c.error)
    return warn(
      'loud',
      'child_failed_to_start',
      `The command failed to start (${c.error}), so nothing it would have sent reached the relay.`,
    );
  if (c.signal) return warn('loud', 'child_signal', `The child was ended by signal ${c.signal}.`);
  if (c.exit_code !== null && c.exit_code !== 0)
    return warn('loud', 'child_failed', `The child exited with code ${c.exit_code}.`);
  return null;
}

function relay_warnings(run, reader) {
  const out = [];
  if (run.child?.interrupted)
    out.push(
      warn(
        'warn',
        'interrupted',
        'The run was interrupted and the signal was forwarded to the child; figures cover what happened until then.',
      ),
    );
  if (run.rejected_requests)
    out.push(
      warn(
        'warn',
        'rejected_requests',
        `The relay refused ${plural(run.rejected_requests, 'request')} that carried a wrong token (404, not forwarded). Something other than the child, or a stale child from an earlier run, was talking to the relay.`,
      ),
    );
  if (run.relay_errors && run.relay_errors !== reader.relay_errors) {
    out.push(
      warn(
        'warn',
        'relay_error_count',
        `run.json counts ${plural(run.relay_errors, 'relay error')} but the journal holds ${reader.relay_errors}.`,
      ),
    );
  }
  return out;
}

function input_warnings(reader, ordering) {
  const out = [];
  if (!reader.journal_present)
    out.push(
      warn('warn', 'journal_missing', 'journal.jsonl is missing, so no request could be analysed.'),
    );
  if (reader.malformed)
    out.push(
      warn(
        'warn',
        'malformed_lines',
        `${plural(reader.malformed, 'journal line')} could not be read and were skipped.`,
      ),
    );
  if (reader.relay_errors)
    out.push(
      warn(
        'warn',
        'relay_errors',
        `The relay recorded ${plural(reader.relay_errors, 'internal error')}; affected requests received a 502 \`outagesoftRelayError\`.`,
      ),
    );
  if (reader.missing_url_key)
    out.push(
      warn(
        'warn',
        'missing_url_key',
        `${plural(reader.missing_url_key, 'record')} had no url_key and were grouped by templated URL, which merges distinct items.`,
      ),
    );
  if (ordering?.late)
    out.push(
      warn(
        'warn',
        'late_lines',
        `${plural(ordering.late, 'record')} arrived in the journal later than the reorder horizon allowed; their retry relations may be misattributed.`,
      ),
    );
  return out;
}

/** Warnings about the trustworthiness of the run, loudest first. */
export function build_warnings(run_info, reader, attempts, ordering) {
  const { run, issues } = run_info;
  const out = [];
  if (!attempts && (run.relayed_requests === 0 || run.relayed_requests === null)) {
    const text = run.child?.error
      ? 'No requests were relayed because the command failed to start; nothing in this report describes how it handles faults.'
      : 'No requests were relayed. The preload did not engage, so the child reached Microsoft 365 directly or not at all, and nothing in this report describes how it handles faults.';
    out.push(warn('loud', 'zero_relayed', text));
  }
  const replay = replay_warning(run.replay);
  if (replay) out.push(replay);
  const child = child_warning(run);
  if (child) out.push(child);
  for (const issue of issues) out.push(warn('warn', 'run_info', issue));
  if (run.relayed_requests !== null && run.relayed_requests > attempts) {
    out.push(
      warn(
        'warn',
        'unjournaled',
        `The relay counted ${run.relayed_requests} requests but the journal holds ${attempts}; the rest were still in flight when the run ended.`,
      ),
    );
  }
  return [...out, ...relay_warnings(run, reader), ...input_warnings(reader, ordering)];
}

function chain_observation(chains) {
  const injected = chains.by_origin.filter((o) => o.injected);
  const total = injected.reduce((n, o) => n + o.chains, 0);
  if (!total) return null;
  const sum = (k) => injected.reduce((n, o) => n + o[k], 0);
  const unrecovered = sum('unrecovered');
  const not_retried = sum('not_retried');
  return `Of ${plural(total, 'request')} failed by an injected fault, ${sum('recovered')} recovered after a retry, ${unrecovered} ${was_were(unrecovered)} retried and still failing at the end, and ${not_retried} ${was_were(not_retried)} never requested again.`;
}

function outage_observation(w) {
  const recovery =
    w.first_usable_after_ms === null
      ? `no usable ${w.service} response followed the window`
      : `the first usable ${w.service} response completed ${format_ms(w.first_usable_after_ms)} after it ended`;
  return `During the ${w.service} outage (${format_offset(w.start_ms)} for ${format_ms(w.duration_ms)}) the client made ${plural(w.requests, 'request')} to it, at most ${w.attempts_per_url.max ?? 0} attempts per URL; ${recovery}.`;
}

/** The headline observations about how the client reacted, most important first. */
export function build_observations(second) {
  const out = [];
  const { relations, chains } = second;
  const chain_line = chain_observation(chains);
  if (chain_line) out.push(chain_line);
  if (relations.retry_safety.resent_reached) {
    const n = relations.retry_safety.resent_reached;
    out.push(
      `${plural(n, 'non-idempotent request')} ${was_were(n)} re-sent after the upstream had already processed the first send, so the write likely ran twice.`,
    );
  }
  const ra = relations.retry_after;
  if (ra.early)
    out.push(
      `${ra.early} of ${ra.honoured + ra.early} retries after a Retry-After came early (tightest ${format_ms(ra.tightest.gap_ms)} against ${format_ms(ra.tightest.advised_ms)} advised).`,
    );
  for (const w of second.windows) out.push(outage_observation(w));
  const silent = relations.content.filter(
    (c) => c.fault_id === 'drop_next_link' && c.not_re_requested,
  );
  for (const c of silent)
    out.push(
      `${plural(c.not_re_requested, 'page')} lost its nextLink and the page was not requested again: the rest of that listing was likely never read.`,
    );
  if (chains.backoff.hammering_chains)
    out.push(
      `${plural(chains.backoff.hammering_chains, 'retry chain')} retried a 429 or 5xx without backing off.`,
    );
  if (ra.honoured && !ra.early)
    out.push(`All ${ra.honoured} retries after a Retry-After waited the advised time.`);
  return out.slice(0, MAX_OBSERVATIONS);
}
