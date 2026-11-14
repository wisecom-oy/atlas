/**
 * Correctness verdicts about completeness: checks 4 to 9 of the spec.
 *
 * Traffic cannot prove a backup complete. These checks find the patterns that make loss likely
 * (a corrupt answer accepted, a faulted request never satisfied while the child exited 0) and point
 * at the evidence that can settle it: the verify command and a compare against a baseline run.
 */
import { child_status } from '../journal/run-info.mjs';
import { verdict_row } from './verdicts-retry.mjs';
import { plural, was_were } from '../render/report-format.mjs';

const DETECTABLE_CONTENT = new Set(['malformed_json', 'empty_body_200', 'truncated_body']);
const UNDETECTABLE_CONTENT = new Set(['drop_next_link', 'duplicate_items', 'shuffle_items']);
const VERIFY_HINT =
  'run again with `--verify-cmd "<verification command>"`, or `outagesoft-365 compare <passthrough-run> <this-run>`';

/** Check 4: work that already completed cleanly was not fetched again. */
export function check_duplicate_processing(facts) {
  const ids = facts.second.identities;
  const extra = ids.refetch.reduce((n, r) => n + r.extra_fetches, 0);
  const evidence = Object.fromEntries(
    ids.refetch.map((r) => [`${r.kind}_refetches`, r.extra_fetches]),
  );
  evidence.keyed_by = facts.reader.with_identity_key
    ? 'identity_key'
    : 'url_key (journal has no identity_key)';
  const title = 'No duplicate processing';
  if (!extra) {
    const any_get = facts.first.traffic.shapes.some((s) => s.method === 'GET');
    return verdict_row(
      4,
      title,
      any_get ? 'PASS' : 'NOT OBSERVED',
      any_get ? 'No completed GET was fetched again.' : 'No GET requests were relayed.',
      evidence,
    );
  }
  const split = ids.refetch.map((r) => `${r.kind} ${r.extra_fetches}`).join(', ');
  const examples = ids.refetch.flatMap((r) => r.examples);
  return verdict_row(
    4,
    title,
    'WARN',
    `${plural(extra, 'fetch', 'fetches')} repeated work that had already completed (${split}); polling endpoints show up here too.`,
    evidence,
    examples,
  );
}

/** Check 5: a faulted paged request resumed from its own page or restarted only when told to. */
export function check_checkpoint_resume(facts) {
  const r = facts.second.identities.resume;
  const title = 'Resumed from a valid checkpoint';
  if (!facts.reader.attempts)
    return verdict_row(5, title, 'NOT OBSERVED', 'No requests were relayed.', {});
  if (!facts.reader.with_cursor) {
    return verdict_row(
      5,
      title,
      'NEEDS EVIDENCE',
      'The journal has no cursor field, so paged requests cannot be recognised.',
      {},
    );
  }
  const evidence = {
    ...r,
    listing_keyed_by: facts.reader.with_base_key
      ? 'base_key'
      : 'identity_key (journal has no base_key)',
  };
  delete evidence.examples;
  if (!r.faulted)
    return verdict_row(
      5,
      title,
      'NOT OBSERVED',
      'No request carrying a delta or skip token was faulted.',
      evidence,
    );
  const undemanded = r.restart_undemanded + r.other_token_undemanded;
  if (undemanded || r.abandoned) {
    const parts = [];
    if (r.restart_undemanded)
      parts.push(`${r.restart_undemanded} restarted the enumeration unprompted`);
    if (r.other_token_undemanded)
      parts.push(`${r.other_token_undemanded} continued with a different token`);
    if (r.abandoned) parts.push(`${r.abandoned} were never requested again`);
    return verdict_row(
      5,
      title,
      'WARN',
      `Of ${r.faulted} faulted paged requests, ${parts.join(', ')}.`,
      evidence,
      r.examples,
    );
  }
  return verdict_row(
    5,
    title,
    'PASS',
    `${r.faulted} faulted paged requests resumed from the same page or restarted after a resync demand.`,
    evidence,
  );
}

function summarise_content(content) {
  const pick = (set) => content.filter((c) => set.has(c.fault_id));
  const detectable = pick(DETECTABLE_CONTENT);
  const undetectable = pick(UNDETECTABLE_CONTENT);
  return {
    detectable_applied: detectable.reduce((n, c) => n + c.applied, 0),
    detectable_not_re_requested: detectable.reduce((n, c) => n + c.not_re_requested, 0),
    undetectable_applied: undetectable.reduce((n, c) => n + c.applied, 0),
    examples: detectable.flatMap((c) => c.not_re_requested_shapes),
  };
}

/** Check 6: corrupt answers were re-requested or surfaced, never accepted silently. */
export function check_corrupt_answers(facts) {
  const s = summarise_content(facts.second.relations.content);
  const { examples, ...evidence } = s;
  const title = 'Corrupt answers were not accepted silently';
  const undetectable_note = s.undetectable_applied
    ? ` Content faults invisible on the wire (drop_next_link, duplicate_items, shuffle_items): ${s.undetectable_applied}; to check them, ${VERIFY_HINT}.`
    : '';
  if (!s.detectable_applied) {
    if (!s.undetectable_applied)
      return verdict_row(6, title, 'NOT OBSERVED', 'No content fault was applied.', evidence);
    return verdict_row(6, title, 'NEEDS EVIDENCE', undetectable_note.trim(), evidence);
  }
  if (s.detectable_not_re_requested) {
    const child = child_status(facts.run);
    if (child === 'exited_zero') {
      return verdict_row(
        6,
        title,
        'FAIL',
        `${plural(s.detectable_not_re_requested, 'corrupt response')} ${was_were(s.detectable_not_re_requested)} never re-requested and the child exited 0.${undetectable_note}`,
        evidence,
        examples,
      );
    }
    if (child === 'unknown') {
      return verdict_row(
        6,
        title,
        'NEEDS EVIDENCE',
        `${plural(s.detectable_not_re_requested, 'corrupt response')} ${was_were(s.detectable_not_re_requested)} never re-requested and the child's exit code is unknown.${undetectable_note}`,
        evidence,
        examples,
      );
    }
  }
  const verdict = s.undetectable_applied ? 'NEEDS EVIDENCE' : 'PASS';
  const handled = s.detectable_not_re_requested
    ? `${s.detectable_applied - s.detectable_not_re_requested} of ${plural(s.detectable_applied, 'corrupt response')} ${was_were(s.detectable_applied)} re-requested and the child exited non-zero, so the rest surfaced.`
    : s.detectable_applied === 1
      ? 'The corrupt response was re-requested.'
      : `All ${s.detectable_applied} corrupt responses were re-requested.`;
  return verdict_row(6, title, verdict, `${handled}${undetectable_note}`, evidence);
}

/** Check 7: every faulted request was later satisfied, or the child surfaced the failure. */
export function check_faults_satisfied(facts) {
  const u = facts.second.identities.unsatisfied;
  const injected_failures = facts.second.chains.by_origin
    .filter((o) => o.injected)
    .reduce((n, o) => n + o.chains, 0);
  const evidence = {
    injected_failure_chains: injected_failures,
    never_satisfied: u.count,
    child: child_status(facts.run),
  };
  const title = 'Every faulted request was satisfied or surfaced';
  if (!injected_failures)
    return verdict_row(
      7,
      title,
      'NOT OBSERVED',
      'No injected fault made a request fail.',
      evidence,
    );
  if (!u.count)
    return verdict_row(
      7,
      title,
      'PASS',
      `All ${injected_failures} injected failures were followed by a usable response for the same request.`,
      evidence,
    );
  const faults = u.by_fault.map((f) => `${f.key} ${f.count}`).join(', ');
  if (evidence.child === 'exited_zero') {
    return verdict_row(
      7,
      title,
      'FAIL',
      `${plural(u.count, 'faulted request')} never got a usable response (${faults}) yet the child exited 0: a failure was swallowed.`,
      evidence,
      u.examples,
    );
  }
  if (evidence.child === 'unknown') {
    return verdict_row(
      7,
      title,
      'NEEDS EVIDENCE',
      `${plural(u.count, 'faulted request')} never got a usable response (${faults}) and the child's exit code is unknown.`,
      evidence,
      u.examples,
    );
  }
  return verdict_row(
    7,
    title,
    'PASS',
    `${plural(u.count, 'faulted request')} never got a usable response, and the child surfaced it by exiting non-zero or failing to start.`,
    evidence,
    u.examples,
  );
}

/** Check 8: the backup is verifiably complete, from the verify command's exit code. */
export function check_backup_complete(facts) {
  const v = facts.run.verify;
  const title = 'Backup verifiably complete';
  if (!v || v.exit_code === null) {
    return verdict_row(
      8,
      title,
      'NEEDS EVIDENCE',
      `Traffic cannot prove completeness: ${VERIFY_HINT}.`,
      {},
      [],
      'no verify command was run',
    );
  }
  const evidence = { verify_exit_code: v.exit_code, verify_duration_ms: v.duration_ms };
  const basis = 'verify command exit code';
  if (v.exit_code === 0)
    return verdict_row(8, title, 'PASS', 'The verify command exited 0.', evidence, [], basis);
  return verdict_row(
    8,
    title,
    'FAIL',
    `The verify command exited ${v.exit_code}.`,
    evidence,
    [],
    basis,
  );
}

/** Check 9: in a replay run, every scheduled fault was applied. */
export function check_replay_fidelity(facts) {
  const r = facts.run.replay;
  const title = 'Replay fidelity';
  if (!r) return verdict_row(9, title, 'NOT OBSERVED', 'Not a replay run.', {}, [], 'run.json');
  const evidence = { ...r };
  const basis = 'run.json replay counters';
  if (r.scheduled !== null && r.applied === r.scheduled && !r.not_encountered) {
    return verdict_row(
      9,
      title,
      'PASS',
      `All ${r.scheduled} scheduled faults were applied.`,
      evidence,
      [],
      basis,
    );
  }
  return verdict_row(
    9,
    title,
    'WARN',
    `${r.applied ?? 0} of ${r.scheduled ?? 0} scheduled faults were applied; ${r.not_encountered ?? 0} scheduled requests never came, so the client's behaviour (or the tenant) changed.`,
    evidence,
    [],
    basis,
  );
}
