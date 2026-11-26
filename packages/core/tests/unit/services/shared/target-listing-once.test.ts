/**
 * Issue #886: a restore listed a target calendar or contact folder again for every entry after its
 * listing failed, each time with a full retry budget.
 */
import { describe, expect, it, vi } from 'vitest';
import { AuthError, GraphUnavailableError, MailboxNotLicensedError } from '@wisecom/atlas-types';
import { run_with_abort_signal } from '@/services/shared/graph-request-context';
import { list_target_once, type TargetListings } from '@/services/shared/target-listing-once';

const WHAT = 'the events in the target calendar';

function outage(): GraphUnavailableError {
  return new GraphUnavailableError('Microsoft Graph kept failing after 12 retries', {
    retries: 12,
    elapsed_ms: 1_411_000,
  });
}

/** Reads `target_id` `times` times through one memo and returns each outcome. */
async function read_times(
  listings: TargetListings<string[]>,
  target_id: string,
  list: () => Promise<string[]>,
  times: number,
): Promise<unknown[]> {
  const outcomes: unknown[] = [];
  for (let i = 0; i < times; i++) {
    outcomes.push(await list_target_once(listings, target_id, WHAT, list).catch((e: unknown) => e));
  }
  return outcomes;
}

describe('list_target_once', () => {
  it('lists a target once and reuses what it holds', async () => {
    const list = vi.fn(async () => ['event-1']);
    const listings: TargetListings<string[]> = new Map();

    const outcomes = await read_times(listings, 'cal-1', list, 3);

    expect(list).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([['event-1'], ['event-1'], ['event-1']]);
  });

  it('does not list a target again after its listing failed', async () => {
    const list = vi.fn(async (): Promise<string[]> => {
      throw outage();
    });
    const listings: TargetListings<string[]> = new Map();

    const outcomes = await read_times(listings, 'cal-1', list, 3);

    expect(list).toHaveBeenCalledTimes(1);
    expect(outcomes[1]).toBe(outcomes[0]);
    expect(outcomes[2]).toBe(outcomes[0]);
  });

  it('names the listing in the failure and keeps the cause', async () => {
    const cause = outage();
    const listings: TargetListings<string[]> = new Map();

    const failure = await list_target_once(listings, 'cal-1', WHAT, () =>
      Promise.reject(cause),
    ).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'could not list the events in the target calendar: ' +
        'Microsoft Graph kept failing after 12 retries',
    );
    expect((failure as Error).cause).toBe(cause);
  });

  it('keeps one target failure from touching another target', async () => {
    const listings: TargetListings<string[]> = new Map();
    await list_target_once(listings, 'cal-1', WHAT, () => Promise.reject(outage())).catch(
      () => undefined,
    );

    const other = await list_target_once(listings, 'cal-2', WHAT, async () => ['event-2']);

    expect(other).toEqual(['event-2']);
  });

  it.each([
    ['AuthError', () => new AuthError('Calendars.ReadWrite is not granted')],
    ['MailboxNotLicensedError', () => new MailboxNotLicensedError('MailboxNotEnabledForRESTAPI')],
  ])('rethrows %s unchanged and does not remember it', async (_name, make) => {
    const refusal = make();
    const list = vi.fn((): Promise<string[]> => Promise.reject(refusal));
    const listings: TargetListings<string[]> = new Map();

    const outcomes = await read_times(listings, 'cal-1', list, 2);

    expect(outcomes).toEqual([refusal, refusal]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('rethrows a cancellation unchanged and does not remember it', async () => {
    const controller = new AbortController();
    const cancel = new Error('Run interrupted by Ctrl+C');
    const listings: TargetListings<string[]> = new Map();

    const outcome = await run_with_abort_signal(controller.signal, () =>
      list_target_once(listings, 'cal-1', WHAT, () => {
        controller.abort(cancel);
        return Promise.reject(cancel);
      }).catch((e: unknown) => e),
    );

    expect(outcome).toBe(cancel);
    expect(listings.has('cal-1')).toBe(false);
  });
});
