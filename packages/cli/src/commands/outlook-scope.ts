/**
 * One precedence rule for the `-s` / `-m` pair across every `atlas outlook` subcommand.
 *
 * The three subcommands used to answer the same invocation three different ways: `list` let `-s`
 * win, `restore` entered snapshot mode and quietly reused `-m` as a cross-mailbox target, and
 * `save` let `-m` win, so an explicit `-s` was discarded and the whole mailbox exported instead
 * (issue #201). Only the last one lost data the operator asked for, but all three made the flags
 * mean whatever the handler happened to check first.
 *
 * `-s` wins, matching `atlas replicate`, which checks `--snapshot` before `--mailbox`. A snapshot
 * id names exactly one thing, so it is the narrower request of the two, and narrower should not be
 * silently widened.
 */

export interface OutlookScopeOptions {
  readonly snapshot?: string;
  readonly mailbox?: string;
  readonly target?: string;
}

export type OutlookScope =
  | { readonly mode: 'snapshot'; readonly snapshot: string; readonly ignored: readonly string[] }
  | { readonly mode: 'mailbox'; readonly mailbox: string; readonly ignored: readonly string[] }
  | { readonly mode: 'none'; readonly ignored: readonly string[] };

/**
 * Resolves which scope an outlook subcommand should act on.
 *
 * `ignored` names the flags the chosen scope makes irrelevant, so a caller can report them instead
 * of dropping them on the floor. It is the caller's decision whether that is a warning or a
 * failure: a read-only listing can warn and carry on, while a restore writes mail into a mailbox
 * and should not guess which one.
 */
export function resolve_outlook_scope(options: OutlookScopeOptions): OutlookScope {
  if (options.snapshot) {
    const ignored: string[] = [];
    if (options.mailbox) ignored.push('-m, --mailbox');
    return { mode: 'snapshot', snapshot: options.snapshot, ignored };
  }

  if (options.mailbox) {
    return { mode: 'mailbox', mailbox: options.mailbox, ignored: [] };
  }

  return { mode: 'none', ignored: [] };
}

/** One-line description of a scope conflict, or undefined when the flags are unambiguous. */
export function describe_scope_conflict(scope: OutlookScope): string | undefined {
  if (scope.ignored.length === 0) return undefined;
  return `-s, --snapshot takes precedence, so ${scope.ignored.join(' and ')} ${
    scope.ignored.length === 1 ? 'is' : 'are'
  } ignored`;
}
