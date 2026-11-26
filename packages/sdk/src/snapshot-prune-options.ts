import type { SnapshotPruneOptions, SnapshotPruneSdkOptions } from '@wisecom/atlas-types';

/**
 * Checks and converts `pruneSnapshots` options at the call boundary. A prune deletes data, so a
 * cut-off that does not parse fails here with the method named, rather than being read as some
 * other instant; JavaScript callers reach this without the compiler's help.
 */
export function adapt_prune_options(
  options: SnapshotPruneSdkOptions | undefined,
  method: string,
): SnapshotPruneOptions {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError(`${method} requires an options object with a before date`);
  }
  if (options.dryRun !== undefined && typeof options.dryRun !== 'boolean') {
    throw new TypeError(`${method} requires dryRun to be a boolean when given`);
  }
  const { signal } = options;
  return {
    before: parse_cutoff(options.before, method),
    dry_run: options.dryRun === true,
    ...(signal && { should_interrupt: () => signal.aborted, abort_signal: signal }),
  };
}

function parse_cutoff(before: unknown, method: string): Date {
  const cutoff =
    before instanceof Date
      ? new Date(before.getTime())
      : typeof before === 'string' && before.trim() !== ''
        ? new Date(before)
        : undefined;
  if (cutoff === undefined || Number.isNaN(cutoff.getTime())) {
    throw new TypeError(`${method} requires before to be a valid Date or ISO 8601 string`);
  }
  return cutoff;
}
