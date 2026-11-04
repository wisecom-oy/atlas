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
 * Advances one root after a run that still found its hosted content missing. Returns the new
 * attempt count, or undefined once the limit is reached: that run warns it gave up, and the root
 * is no longer re-checked.
 */
export function advance_hosted_recheck(
  channel_id: string,
  root_id: string,
  previous: number | undefined,
  warnings: string[],
): number | undefined {
  const attempt = (previous ?? 0) + 1;
  const where = `Channel ${channel_id} root ${root_id}`;
  if (attempt >= MAX_HOSTED_RECHECK_ATTEMPTS) {
    warnings.push(
      `${where}: hosted content still missing after ${attempt} attempts; gave up re-checking`,
    );
    return undefined;
  }
  warnings.push(
    `${where}: hosted content still missing (attempt ${attempt} of ${MAX_HOSTED_RECHECK_ATTEMPTS}); re-checking next run`,
  );
  return attempt;
}
