/**
 * When a repeated "not found" answer from Microsoft Graph is believed.
 *
 * A `404` is not proof that an object is gone. Graph answers it during incidents and from replica
 * lag, and `with_graph_retry` never retries one. A workload that would lose data by taking one
 * answer at its word keeps a streak of consecutive "not found" answers instead, and accepts the
 * absence only once the streak has repeated on enough runs across enough time that a passing fault
 * is no longer a credible cause (issues #850, #855 and #854).
 */

import type { NotFoundStreak } from '@wisecom/atlas-types';

/** Consecutive runs that must answer "not found" before the absence is accepted. */
export const NOT_FOUND_CONFIRMATION_READS = 3;

/** How long the "not found" answers must span, first to latest, before the absence is accepted. */
export const NOT_FOUND_CONFIRMATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The streak with this run's "not found" answer added, started now if there was none. */
export function extend_not_found_streak(
  previous: NotFoundStreak | undefined,
  now: Date,
): NotFoundStreak {
  // An unreadable start time restarts the streak, so the window can still elapse.
  if (!previous || Number.isNaN(Date.parse(previous.since))) {
    return { reads: 1, since: now.toISOString() };
  }
  return { reads: previous.reads + 1, since: previous.since };
}

/**
 * True once the streak has both enough reads and enough elapsed time. Both are required: the count
 * alone lets a one-hour incident decide it on a 15-minute schedule, and the time alone lets two
 * runs a day apart decide it on two answers.
 */
export function is_not_found_confirmed(streak: NotFoundStreak, now: Date): boolean {
  const elapsed_ms = now.getTime() - Date.parse(streak.since);
  return (
    streak.reads >= NOT_FOUND_CONFIRMATION_READS && elapsed_ms >= NOT_FOUND_CONFIRMATION_WINDOW_MS
  );
}

/** How far the streak is from being accepted, in the operator's terms. */
export function describe_not_found_streak(streak: NotFoundStreak, accepted_as: string): string {
  const window_hours = NOT_FOUND_CONFIRMATION_WINDOW_MS / (60 * 60 * 1000);
  return (
    `${streak.reads} run(s) in a row since ${streak.since}; treated as ${accepted_as} after ` +
    `${NOT_FOUND_CONFIRMATION_READS} runs spanning ${window_hours} hours`
  );
}
