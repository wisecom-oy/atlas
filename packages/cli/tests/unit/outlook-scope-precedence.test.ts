import { describe, expect, it } from 'vitest';
import { describe_scope_conflict, resolve_outlook_scope } from '@/commands/outlook-scope';

/**
 * Issue #201: the three outlook subcommands answered the same invocation three different ways.
 * `save` was the one that lost work: it let `-m` win, so `save -s <id> -m <mailbox>` discarded the
 * snapshot and exported the entire mailbox instead.
 *
 * `-s` wins everywhere now, matching `atlas replicate`, which checks `--snapshot` before
 * `--mailbox`.
 */
describe('resolve_outlook_scope', () => {
  it('picks snapshot mode when only -s is given', () => {
    const scope = resolve_outlook_scope({ snapshot: 'snap-1' });
    expect(scope).toEqual({ mode: 'snapshot', snapshot: 'snap-1', ignored: [] });
  });

  it('picks mailbox mode when only -m is given', () => {
    const scope = resolve_outlook_scope({ mailbox: 'john.doe@example.com' });
    expect(scope).toEqual({ mode: 'mailbox', mailbox: 'john.doe@example.com', ignored: [] });
  });

  it('lets -s win over -m, and says which flag it ignored', () => {
    const scope = resolve_outlook_scope({ snapshot: 'snap-1', mailbox: 'john.doe@example.com' });

    expect(scope.mode).toBe('snapshot');
    expect(scope.ignored).toEqual(['-m, --mailbox']);
  });

  it('resolves the same way whichever order the flags were written in', () => {
    const a = resolve_outlook_scope({ snapshot: 'snap-1', mailbox: 'john.doe@example.com' });
    const b = resolve_outlook_scope({ mailbox: 'john.doe@example.com', snapshot: 'snap-1' });
    expect(a).toEqual(b);
  });

  it('picks no scope when neither flag is given', () => {
    expect(resolve_outlook_scope({}).mode).toBe('none');
  });

  it('does not treat -T as a scope flag', () => {
    // -T redirects where a restore lands; it never selects what to restore.
    const scope = resolve_outlook_scope({ snapshot: 'snap-1', target: 'jane.roe@example.com' });
    expect(scope.mode).toBe('snapshot');
    expect(scope.ignored).toEqual([]);
  });
});

describe('describe_scope_conflict', () => {
  it('is silent when the flags are unambiguous', () => {
    expect(describe_scope_conflict(resolve_outlook_scope({ snapshot: 'snap-1' }))).toBeUndefined();
    expect(
      describe_scope_conflict(resolve_outlook_scope({ mailbox: 'john.doe@example.com' })),
    ).toBeUndefined();
  });

  it('names the ignored flag so nothing is dropped silently', () => {
    const message = describe_scope_conflict(
      resolve_outlook_scope({ snapshot: 'snap-1', mailbox: 'john.doe@example.com' }),
    );

    expect(message).toContain('-s, --snapshot takes precedence');
    expect(message).toContain('-m, --mailbox');
  });
});
