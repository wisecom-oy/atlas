import { describe, expect, it } from 'vitest';
import { run_with_throttle_coordinator } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { recording_throttle_coordinator } from '@wisecom/atlas-types/testing/recording-throttle-coordinator';
import { report_transfer_throttle, wait_for_transfer_slot } from '@/graph-transfer-throttle';

function response_with(status: number, retry_after?: string): Response {
  const headers = retry_after === undefined ? {} : { 'Retry-After': retry_after };
  return new Response(null, { status, headers });
}

describe('wait_for_transfer_slot', () => {
  it('resolves without a coordinator in scope', async () => {
    await expect(wait_for_transfer_slot()).resolves.toBeUndefined();
  });

  it('waits on the sharepoint_onedrive pool even when the ambient default pool differs', async () => {
    const coordinator = recording_throttle_coordinator();

    await run_with_throttle_coordinator(coordinator, 'outlook', () => wait_for_transfer_slot());

    expect(coordinator.waits).toEqual(['sharepoint_onedrive']);
  });

  it('lets the request through when the coordinator rejects', async () => {
    const coordinator = recording_throttle_coordinator();
    coordinator.wait = async () => {
      throw new Error('shared state unavailable');
    };

    await expect(
      run_with_throttle_coordinator(coordinator, 'outlook', () => wait_for_transfer_slot()),
    ).resolves.toBeUndefined();
  });

  it('stops waiting out a cooldown as soon as the run is cancelled', async () => {
    const coordinator = recording_throttle_coordinator();
    coordinator.wait = () => new Promise<void>(() => undefined);
    const controller = new AbortController();

    const waiting = run_with_throttle_coordinator(coordinator, 'outlook', () =>
      wait_for_transfer_slot(controller.signal),
    );
    controller.abort(new Error('cancelled'));

    await expect(waiting).rejects.toThrow('cancelled');
  });
});

describe('report_transfer_throttle', () => {
  it.each([
    ['429 with seconds', response_with(429, '7'), 7_000],
    ['503 with seconds', response_with(503, '3'), 3_000],
  ])('raises the cooldown for %s', (_label, response, expected_ms) => {
    const coordinator = recording_throttle_coordinator();

    run_with_throttle_coordinator(coordinator, 'outlook', () => report_transfer_throttle(response));

    expect(coordinator.raises).toEqual([['sharepoint_onedrive', expected_ms]]);
  });

  it.each([
    ['429 without Retry-After', response_with(429)],
    ['500 with Retry-After', response_with(500, '7')],
    ['200', response_with(200)],
  ])('does not raise for %s', (_label, response) => {
    const coordinator = recording_throttle_coordinator();

    run_with_throttle_coordinator(coordinator, 'outlook', () => report_transfer_throttle(response));

    expect(coordinator.raises).toEqual([]);
  });

  it('does nothing without a coordinator in scope', () => {
    expect(() => report_transfer_throttle(response_with(429, '7'))).not.toThrow();
  });

  it('logs rather than throws when the coordinator throws on raise', () => {
    const coordinator = recording_throttle_coordinator();
    coordinator.raise = () => {
      throw new Error('shared state unavailable');
    };

    expect(() =>
      run_with_throttle_coordinator(coordinator, 'outlook', () =>
        report_transfer_throttle(response_with(429, '7')),
      ),
    ).not.toThrow();
  });
});
