import type { HeldOwnerLease, OwnerLeasePort, OwnerLeaseRequest } from '@/ports/lease';

/** An owner-lease port that grants every request in memory and records what a service did. */
export interface StubOwnerLeases {
  readonly leases: OwnerLeasePort;
  /** Every lease a service asked for, in order, including refused ones. */
  readonly requests: OwnerLeaseRequest[];
  /** `acquire`, `assert` and `release` in the order they happened, for ordering assertions. */
  readonly events: string[];
  /** Leases granted and not yet released. */
  readonly held: () => number;
  /**
   * Makes every later acquire reject with `error`, as when another operation holds the owner. The
   * test supplies the error because these helpers are loaded from source by every package and
   * cannot import a class at run time.
   */
  readonly refuse_with: (error: Error) => void;
  /** Makes `assert_held` throw `error` from now on, as when a held lease was lost. */
  readonly fail_checks_with: (error: Error) => void;
}

/** A lease that is always held, for a step that is handed a lease rather than taking one. */
export function stub_held_owner_lease(): HeldOwnerLease {
  return {
    storage_key: 'stub-lease/held.json',
    assert_held: (): void => undefined,
    release: async (): Promise<void> => undefined,
  };
}

/**
 * Builds the stub. The lease mechanics have their own tests in core; a workload test only needs to
 * see that its service takes the lease first, checks it before committing, and always releases it.
 */
export function stub_owner_leases(): StubOwnerLeases {
  const requests: OwnerLeaseRequest[] = [];
  const events: string[] = [];
  let held = 0;
  let refusal: Error | undefined;
  let lost: Error | undefined;

  const grant = (request: OwnerLeaseRequest): HeldOwnerLease => {
    let released = false;
    return {
      storage_key: `stub-lease/${request.workload}/${request.owner_id}.json`,
      assert_held: (): void => {
        events.push('assert');
        if (lost !== undefined) throw lost;
      },
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        held--;
        events.push('release');
      },
    };
  };

  const leases: OwnerLeasePort = {
    acquire: async (_ctx, request) => {
      requests.push(request);
      events.push('acquire');
      if (refusal !== undefined) throw refusal;
      held++;
      return grant(request);
    },
  };

  return {
    leases,
    requests,
    events,
    held: () => held,
    refuse_with: (error): void => {
      refusal = error;
    },
    fail_checks_with: (error): void => {
      lost = error;
    },
  };
}
