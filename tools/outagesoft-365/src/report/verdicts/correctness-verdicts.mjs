/**
 * Runs the nine correctness checks and ranks their verdicts.
 *
 * NOT OBSERVED means the run gave the client no opportunity to show the behaviour; NEEDS EVIDENCE
 * means the behaviour happened but traffic alone cannot judge it. Neither is a pass.
 */
import { check_backoff, check_retry_after, check_retry_safety } from './verdicts-retry.mjs';
import {
  check_backup_complete,
  check_checkpoint_resume,
  check_corrupt_answers,
  check_duplicate_processing,
  check_faults_satisfied,
  check_replay_fidelity,
} from './verdicts-completeness.mjs';

const SEVERITY = { FAIL: 4, WARN: 3, 'NEEDS EVIDENCE': 2, PASS: 1, 'NOT OBSERVED': 0 };

const CHECKS = [
  check_retry_after,
  check_backoff,
  check_retry_safety,
  check_duplicate_processing,
  check_checkpoint_resume,
  check_corrupt_answers,
  check_faults_satisfied,
  check_backup_complete,
  check_replay_fidelity,
];

/** Severity rank of a verdict, higher is worse. */
export function verdict_severity(verdict) {
  return SEVERITY[verdict] ?? 0;
}

/** Evaluates every check against the analysis facts `{ run, reader, first, second }`, in spec order. */
export function evaluate_verdicts(facts) {
  return CHECKS.map((check) => check(facts));
}

/** Counts of each verdict, for one-line summaries. */
export function count_verdicts(verdicts) {
  const counts = {};
  for (const v of verdicts) counts[v.verdict] = (counts[v.verdict] ?? 0) + 1;
  return counts;
}
