import type { TeamsSaveResult } from '@wisecom/atlas-types';
import { EXIT_PARTIAL } from '@/command-run-outcome';

/**
 * The exit code a Teams save earns. A channel or message that could not be read exits 1. Hosted
 * content the backup never captured, or an interrupt, leaves the archive partial and exits 2. A
 * complete archive has no code.
 */
export function save_exit_code(
  result: Pick<TeamsSaveResult, 'errors' | 'hosted_missing' | 'interrupted'>,
): number | undefined {
  if (result.errors.length > 0) return 1;
  if (result.interrupted || result.hosted_missing.length > 0) return EXIT_PARTIAL;
  return undefined;
}
