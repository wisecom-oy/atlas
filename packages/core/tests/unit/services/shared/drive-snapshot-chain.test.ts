import { describe, it, expect } from 'vitest';
import {
  fold_drive_snapshot_chain,
  select_drive_manifest_chain,
} from '@/services/shared/drive-snapshot-chain';

interface TestEntry {
  readonly file_id: string;
  readonly change_type: 'created' | 'updated' | 'deleted';
  readonly checksum?: string;
}

function manifest(
  snapshot_id: string,
  created_at: string,
  entries: TestEntry[],
): { snapshot_id: string; created_at: Date; entries: TestEntry[] } {
  return { snapshot_id, created_at: new Date(created_at), entries };
}

const CREATED = (file_id: string, checksum: string): TestEntry => ({
  file_id,
  change_type: 'created',
  checksum,
});
const UPDATED = (file_id: string, checksum: string): TestEntry => ({
  file_id,
  change_type: 'updated',
  checksum,
});
const DELETED = (file_id: string): TestEntry => ({ file_id, change_type: 'deleted' });

describe('fold_drive_snapshot_chain', () => {
  it('carries forward a file that changed only in an older snapshot', () => {
    const chain = [
      manifest('snap-2', '2026-02-01', [UPDATED('small', 'v2')]),
      manifest('snap-1', '2026-01-01', [CREATED('small', 'v1'), CREATED('large', 'big')]),
    ];

    const folded = fold_drive_snapshot_chain(chain);

    expect(folded.map((f) => f.entry.file_id).sort()).toEqual(['large', 'small']);
  });

  it('keeps the newest version of a file that changed more than once', () => {
    const chain = [
      manifest('snap-3', '2026-03-01', [UPDATED('doc', 'v3')]),
      manifest('snap-2', '2026-02-01', [UPDATED('doc', 'v2')]),
      manifest('snap-1', '2026-01-01', [CREATED('doc', 'v1')]),
    ];

    const folded = fold_drive_snapshot_chain(chain);

    expect(folded).toHaveLength(1);
    expect(folded[0]?.entry.checksum).toBe('v3');
  });

  it('tags each entry with the snapshot that recorded it, not the target', () => {
    const chain = [
      manifest('snap-2', '2026-02-01', [UPDATED('small', 'v2')]),
      manifest('snap-1', '2026-01-01', [CREATED('large', 'big')]),
    ];

    const by_file = Object.fromEntries(
      fold_drive_snapshot_chain(chain).map((f) => [f.entry.file_id, f.snapshot_id]),
    );

    expect(by_file['small']).toBe('snap-2');
    expect(by_file['large']).toBe('snap-1');
  });

  it('lets a newer tombstone win over an older stored version', () => {
    const chain = [
      manifest('snap-2', '2026-02-01', [DELETED('gone')]),
      manifest('snap-1', '2026-01-01', [CREATED('gone', 'v1')]),
    ];

    const folded = fold_drive_snapshot_chain(chain);

    expect(folded).toHaveLength(1);
    expect(folded[0]?.entry.change_type).toBe('deleted');
  });

  it('restores a file that was deleted and then re-created', () => {
    const chain = [
      manifest('snap-3', '2026-03-01', [CREATED('again', 'v2')]),
      manifest('snap-2', '2026-02-01', [DELETED('again')]),
      manifest('snap-1', '2026-01-01', [CREATED('again', 'v1')]),
    ];

    const folded = fold_drive_snapshot_chain(chain);

    expect(folded).toHaveLength(1);
    expect(folded[0]?.entry.change_type).toBe('created');
    expect(folded[0]?.entry.checksum).toBe('v2');
  });

  it('returns nothing for an empty chain', () => {
    expect(fold_drive_snapshot_chain([])).toEqual([]);
  });
});

describe('select_drive_manifest_chain', () => {
  const snap1 = manifest('snap-1', '2026-01-01', []);
  const snap2 = manifest('snap-2', '2026-02-01', []);
  const snap3 = manifest('snap-3', '2026-03-01', []);

  it('puts the target first and every older manifest after it, newest-first', () => {
    const chain = select_drive_manifest_chain([snap1, snap3, snap2], snap3);

    expect(chain.map((m) => m.snapshot_id)).toEqual(['snap-3', 'snap-2', 'snap-1']);
  });

  it('excludes manifests newer than the target, so an old snapshot stays a point in time', () => {
    const chain = select_drive_manifest_chain([snap1, snap2, snap3], snap2);

    expect(chain.map((m) => m.snapshot_id)).toEqual(['snap-2', 'snap-1']);
  });

  it('never repeats the target when the listing already contains it', () => {
    const chain = select_drive_manifest_chain([snap1, snap2], snap2);

    expect(chain.filter((m) => m.snapshot_id === 'snap-2')).toHaveLength(1);
  });

  it('keeps the target ahead of another manifest sharing its timestamp', () => {
    const tie = manifest('snap-tie', '2026-02-01', []);

    const chain = select_drive_manifest_chain([tie, snap2], snap2);

    expect(chain[0]?.snapshot_id).toBe('snap-2');
    expect(chain.map((m) => m.snapshot_id)).toContain('snap-tie');
  });
});
