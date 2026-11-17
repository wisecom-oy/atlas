import { describe, expect, it } from 'vitest';

import { new_snapshot_id } from '@/services/backup/backup-snapshot';

describe('new_snapshot_id', () => {
  it('builds ct-snap-<ms>-<hex> and is unique per call', () => {
    const first = new_snapshot_id(1700000000000);
    const second = new_snapshot_id(1700000000000);
    expect(first).toMatch(/^ct-snap-1700000000000-[0-9a-f]{6}$/);
    expect(first).not.toBe(second);
  });
});
