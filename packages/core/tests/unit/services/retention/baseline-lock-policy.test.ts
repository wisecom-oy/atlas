import { describe, expect, it } from 'vitest';
import { baseline_lock_policy } from '@/services/retention/baseline-lock-policy';

const NOW = new Date('2026-06-01T00:00:00Z');

describe('baseline_lock_policy', () => {
  it('keeps the retention the kept snapshot was written with while it still runs', () => {
    const policy = baseline_lock_policy(
      { requested: {}, effective: { mode: 'COMPLIANCE', retain_until: '2026-07-01T00:00:00Z' } },
      NOW,
    );
    expect(policy).toEqual({ mode: 'COMPLIANCE', retain_until: '2026-07-01T00:00:00Z' });
  });

  it('sets none once that retention has ended, or when none was recorded', () => {
    const ended = {
      requested: {},
      effective: { mode: 'GOVERNANCE' as const, retain_until: '2026-05-01T00:00:00Z' },
    };
    expect(baseline_lock_policy(ended, NOW)).toBeUndefined();
    expect(baseline_lock_policy(undefined, NOW)).toBeUndefined();
    expect(baseline_lock_policy({ requested: {}, effective: {} }, NOW)).toBeUndefined();
  });
});
