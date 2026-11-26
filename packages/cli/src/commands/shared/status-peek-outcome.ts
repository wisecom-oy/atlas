import { logger } from '@wisecom/atlas-core';
import { EXIT_PARTIAL } from '@/command-run-outcome';

/** Exit code for Graph throttled or unavailable after the retry budget, as `handle_fatal_error` maps it. */
export const EXIT_TRANSIENT = 3;

/**
 * Error classes a status peek records after Microsoft Graph kept throttling or failing through
 * the retry budget. They map to exit 3 when thrown, so a peek that recorded only these exits 3 too.
 */
const TRANSIENT_PEEK_ERROR_CLASSES: readonly string[] = ['ThrottledError', 'GraphUnavailableError'];

/** True when a `<ErrorClass>: <message>` peek error names a throttle or an unavailable Graph. */
function is_transient_peek_error(peek_error: string): boolean {
  return TRANSIENT_PEEK_ERROR_CLASSES.some((name) => peek_error.startsWith(`${name}: `));
}

/**
 * The exit code for a status run whose peeks failed: 3 when every failure was a throttle or an
 * unavailable Graph after retries, 2 otherwise, and undefined when no peek failed.
 */
export function failed_peek_exit_code(peek_errors: readonly string[]): number | undefined {
  if (peek_errors.length === 0) return undefined;
  return peek_errors.every(is_transient_peek_error) ? EXIT_TRANSIENT : EXIT_PARTIAL;
}

/**
 * Reports the folders or drives a status run could not check and sets their exit code, unless an
 * earlier finding already chose one. Before this, a run that checked nothing exited 0 (#870).
 */
export function report_failed_peeks(
  rows: readonly { readonly peek_error?: string | undefined }[],
  item_noun: string,
): void {
  const peek_errors = rows.flatMap((row) => (row.peek_error === undefined ? [] : [row.peek_error]));
  const exit_code = failed_peek_exit_code(peek_errors);
  if (exit_code === undefined) return;
  const summary = `${item_noun}(s) not checked: ${peek_errors.length}`;
  // A damaged manifest's exit 9 asks for operator action, which a later retry would not replace.
  if (process.exitCode) {
    logger.error(summary);
    return;
  }
  logger.error(`${summary} -- exit ${exit_code}`);
  process.exitCode = exit_code;
}
