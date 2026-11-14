/**
 * The tool's own exit codes, kept apart from the child's.
 *
 * `run` passes the child's exit code through unchanged, and Atlas uses 2 for a
 * partial failure, so the tool's own failures use the sysexits values instead:
 * 64 for bad usage or invalid input, 70 for an internal failure.
 */

/** Exit code for invalid usage or input (sysexits EX_USAGE). */
export const EXIT_USAGE = 64;

/** Exit code for an internal tool failure (sysexits EX_SOFTWARE). */
export const EXIT_INTERNAL = 70;

/** An error caused by the caller's input rather than by the tool. */
export class UsageError extends Error {}

/** Runs `fn`, turning anything it throws into a UsageError with the same message. */
export function as_usage_error(fn) {
  try {
    return fn();
  } catch (error) {
    throw error instanceof UsageError ? error : new UsageError(error?.message ?? String(error));
  }
}
