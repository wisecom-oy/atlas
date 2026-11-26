/**
 * Issue #880. A transfer cooldown is announced only once the coordinator has recorded it, so the log
 * never reports a cooldown that a failing host coordinator never put in force.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { ThrottleCoordinator } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { run_with_throttle_coordinator } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { FailOpenThrottleCoordinator } from '@/fail-open-throttle-coordinator';
import { report_transfer_throttle } from '@/graph-transfer-throttle';

let warn: MockInstance<(message: string) => void>;

function throttled(): Response {
  return new Response(null, { status: 429, headers: { 'Retry-After': '300' } });
}

function coordinator_raising(raise: ThrottleCoordinator['raise']): ThrottleCoordinator {
  return { wait: () => Promise.resolve(), raise };
}

function report_under(coordinator: ThrottleCoordinator): void {
  run_with_throttle_coordinator(coordinator, 'sharepoint_onedrive', () =>
    report_transfer_throttle(throttled()),
  );
}

function wait_lines(): string[] {
  return warn.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith('Waiting'));
}

beforeEach(() => {
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('report_transfer_throttle announcement', () => {
  it('announces a cooldown the coordinator recorded', () => {
    report_under(coordinator_raising(() => undefined));

    expect(wait_lines()).toHaveLength(1);
  });

  it('announces once a coordinator that returns a promise fulfils it', async () => {
    report_under(coordinator_raising(() => Promise.resolve() as unknown as void));
    expect(wait_lines()).toHaveLength(0);

    await Promise.resolve();
    expect(wait_lines()).toHaveLength(1);
  });

  it('does not announce when the coordinator throws on raise', () => {
    report_under(
      coordinator_raising(() => {
        throw new Error('shared state unavailable');
      }),
    );

    expect(wait_lines()).toEqual([]);
  });

  it('does not announce when the coordinator rejects the raise', async () => {
    report_under(
      coordinator_raising(
        () => Promise.reject(new Error('shared state unavailable')) as unknown as void,
      ),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(wait_lines()).toEqual([]);
  });

  it('does not announce when the host coordinator is already wrapped and fails', () => {
    const host = coordinator_raising(() => {
      throw new Error('shared state unavailable');
    });

    report_under(new FailOpenThrottleCoordinator(host));

    expect(wait_lines()).toEqual([]);
  });
});
