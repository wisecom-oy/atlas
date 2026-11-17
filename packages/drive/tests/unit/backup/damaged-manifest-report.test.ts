import { describe, expect, it } from 'vitest';
import { merge_damaged_manifest_keys } from '@/backup/damaged-manifest-report';

describe('merge_damaged_manifest_keys (issue #709)', () => {
  it('names each key once, head keys first', () => {
    expect(merge_damaged_manifest_keys(['m/a', 'm/b'], ['m/b', 'm/c'])).toEqual([
      'm/a',
      'm/b',
      'm/c',
    ]);
  });

  it('returns no keys when neither source skipped a manifest', () => {
    expect(merge_damaged_manifest_keys([], [])).toEqual([]);
  });
});
