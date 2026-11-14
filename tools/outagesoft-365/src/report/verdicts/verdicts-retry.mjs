/**
 * Correctness verdicts about how the client retried: checks 1 to 3 of the spec.
 *
 * Each check is a pure function from the analysis facts to one verdict row. The facts are
 * inferred from the order of relayed requests, so every row says so in its basis.
 */
import { format_ms, plural, was_were } from '../render/report-format.mjs';

const FROM_TRAFFIC = 'inferred from traffic';

/** Builds one verdict row. */
export function verdict_row(
  number,
  title,
  verdict,
  summary,
  evidence,
  examples = [],
  basis = FROM_TRAFFIC,
) {
  return { number, title, verdict, summary, evidence, examples: examples.slice(0, 5), basis };
}

/** Check 1: retries after a Retry-After never arrived before the advised wait minus tolerance. */
export function check_retry_after(facts) {
  const ra = facts.second.relations.retry_after;
  const retried = ra.honoured + ra.early;
  const evidence = {
    advised: ra.advised,
    honoured: ra.honoured,
    early: ra.early,
    not_retried: ra.not_retried,
    tolerance_ms: ra.tolerance_ms,
  };
  const title = 'Retry-After respected';
  if (!retried) {
    const why = ra.advised
      ? `${ra.advised} advised waits, none followed by a retry of the same URL.`
      : 'No response carried a Retry-After.';
    return verdict_row(1, title, 'NOT OBSERVED', why, evidence);
  }
  if (ra.early) {
    const t = ra.tightest;
    return verdict_row(
      1,
      title,
      'FAIL',
      `${ra.early} of ${retried} retries came before the advised wait (tightest ${format_ms(t.gap_ms)} against ${format_ms(t.advised_ms)}).`,
      evidence,
      ra.early_examples,
    );
  }
  return verdict_row(
    1,
    title,
    'PASS',
    `All ${retried} retries waited at least the advised time, within ${ra.tolerance_ms} ms.`,
    evidence,
  );
}

/** Check 2: retries after 429 or 5xx without Retry-After back off instead of hammering. */
export function check_backoff(facts) {
  const b = facts.second.chains.backoff;
  const evidence = {
    chains_measured: b.chains_measured_without_retry_after,
    hammering_chains: b.hammering_chains,
    self_chosen_gap_median_ms: b.self_chosen_ms.median,
  };
  const title = 'Backoff when no Retry-After';
  if (!b.chains_measured_without_retry_after) {
    return verdict_row(
      2,
      title,
      'NOT OBSERVED',
      'No 429 or 5xx without Retry-After was retried.',
      evidence,
    );
  }
  if (b.hammering_chains) {
    return verdict_row(
      2,
      title,
      'WARN',
      `${b.hammering_chains} of ${b.chains_measured_without_retry_after} chains retried within ${b.immediate_retry_ms} ms, or under ${format_ms(b.fast_retry_ms)} with gaps that never grew.`,
      evidence,
      b.hammering_examples,
    );
  }
  return verdict_row(
    2,
    title,
    'PASS',
    `${b.chains_measured_without_retry_after} chains retried with a growing or substantial wait.`,
    evidence,
  );
}

/** Check 3: a non-idempotent request with an ambiguous outcome was not blindly re-sent. */
export function check_retry_safety(facts) {
  const s = facts.second.relations.retry_safety;
  const evidence = {
    ambiguous_non_idempotent: s.ambiguous_writes,
    resent_after_reaching_upstream: s.resent_reached,
    resent_not_reaching_upstream: s.resent_not_reached,
    not_resent: s.not_resent,
    idempotency_unknown: s.unknown_idempotency,
    resent_matched_by_url_only: s.resent_url_only,
  };
  const title = 'Retries are safe';
  const url_note = s.resent_url_only
    ? ` ${s.resent_url_only} of these were matched by URL only (no body digest in the journal), so they may be different writes.`
    : ' Re-sends are matched by URL and body digest.';
  if (!s.ambiguous_writes) {
    return verdict_row(
      3,
      title,
      'NOT OBSERVED',
      'No non-idempotent request ended ambiguously.',
      evidence,
    );
  }
  if (s.unknown_idempotency === s.ambiguous_writes) {
    return verdict_row(
      3,
      title,
      'NEEDS EVIDENCE',
      `The journal has no idempotent field; ${s.ambiguous_writes} POST or PATCH requests ended ambiguously and ${s.resent_reached + s.resent_not_reached} were re-sent.`,
      evidence,
      s.examples,
    );
  }
  if (s.resent_reached) {
    return verdict_row(
      3,
      title,
      'FAIL',
      `${plural(s.resent_reached, 'non-idempotent request')} ${was_were(s.resent_reached)} re-sent after the upstream had already processed the first send: the write likely ran twice.${url_note}`,
      evidence,
      s.examples,
    );
  }
  if (s.resent_not_reached) {
    return verdict_row(
      3,
      title,
      'WARN',
      `${plural(s.resent_not_reached, 'non-idempotent request')} ${was_were(s.resent_not_reached)} re-sent after an ambiguous failure; this time the first send never reached the upstream.${url_note}`,
      evidence,
      s.examples,
    );
  }
  return verdict_row(
    3,
    title,
    'PASS',
    `${plural(s.ambiguous_writes, 'ambiguous non-idempotent failure')} ${was_were(s.ambiguous_writes)} not re-sent.`,
    evidence,
  );
}
