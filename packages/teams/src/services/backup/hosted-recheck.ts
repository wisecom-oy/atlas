import type { TeamsThread } from '@wisecom/atlas-types';

/** How many runs a root's missing hosted content is re-checked before the backup gives up. */
export const MAX_HOSTED_RECHECK_ATTEMPTS = 5;

/** Attempt counts of roots whose hosted content Graph did not return, keyed by root ID. */
export type HostedRecheck = Record<string, number>;

/** True when the thread still lists hosted content that Graph did not return. */
export function has_missing_hosted(thread: TeamsThread): boolean {
  return [thread.root, ...Object.values(thread.replies)].some(
    (ref) => (ref.hosted_missing?.length ?? 0) > 0,
  );
}

/**
 * Records one root's hosted-content state after it was applied: a root still missing content
 * advances its attempt count, and a resolved or removed root leaves the recheck.
 */
export function next_hosted_recheck(
  recheck: HostedRecheck,
  channel_id: string,
  root_id: string,
  thread: TeamsThread | undefined,
  warnings: string[],
): HostedRecheck {
  const attempts =
    thread !== undefined && has_missing_hosted(thread)
      ? advance_hosted_recheck(channel_id, root_id, recheck[root_id], warnings)
      : undefined;
  const next = { ...recheck };
  if (attempts === undefined) delete next[root_id];
  else next[root_id] = attempts;
  return next;
}

/**
 * Advances one root after a run that still found its hosted content missing, and returns its new
 * attempt count. At the limit the count stays there: a delta run no longer re-checks the root, and
 * only the run that reaches the limit warns that it gave up.
 */
export function advance_hosted_recheck(
  channel_id: string,
  root_id: string,
  previous: number | undefined,
  warnings: string[],
): number {
  const attempt = (previous ?? 0) + 1;
  const where = `Channel ${channel_id} root ${root_id}`;
  if (attempt >= MAX_HOSTED_RECHECK_ATTEMPTS) {
    // ponytail: a full read still lists a root at the limit and re-lists its hosted content each run. Skip those roots on full reads if that cost matters.
    if (previous !== MAX_HOSTED_RECHECK_ATTEMPTS) {
      warnings.push(
        `${where}: hosted content still missing after ${MAX_HOSTED_RECHECK_ATTEMPTS} attempts; gave up re-checking`,
      );
    }
    return MAX_HOSTED_RECHECK_ATTEMPTS;
  }
  warnings.push(
    `${where}: hosted content still missing (attempt ${attempt} of ${MAX_HOSTED_RECHECK_ATTEMPTS}); re-checking next run`,
  );
  return attempt;
}
