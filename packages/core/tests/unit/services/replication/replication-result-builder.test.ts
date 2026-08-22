import { describe, it, expect } from 'vitest';
import { build_skip_result } from '@/services/replication/replication-result-builder';

describe('build_skip_result', () => {
  it('reports the present objects as skipped so "nothing to do" is visible', () => {
    const result = build_skip_result('snap-1', 'target-1', 35);

    expect(result.objects_total).toBe(35);
    expect(result.objects_skipped).toBe(35);
    expect(result.objects_copied).toBe(0);
    expect(result.objects_failed).toBe(0);
  });

  it('defaults to zero when no manifest count is given', () => {
    const result = build_skip_result('snap-1', 'target-1');

    expect(result.objects_total).toBe(0);
    expect(result.objects_skipped).toBe(0);
  });
});
