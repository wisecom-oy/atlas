import { describe, expect, it, vi } from 'vitest';
import { classify_empty_run, type EmptyRunEvidence } from '@/backup/empty-run-classifier';

// Issue #572: folders and the library root are delta items but not content, so a full crawl that
// walked only those must report `no_content`. Only walked files distinguish `no_changes`.

function evidence(overrides: Partial<EmptyRunEvidence> = {}): EmptyRunEvidence {
  return {
    previous_kind_by_file_id: {},
    files_processed: 0,
    find_latest_snapshot: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('classify_empty_run', () => {
  it('reports no_content when a full crawl walked nothing and no snapshot exists', async () => {
    await expect(classify_empty_run(evidence())).resolves.toBe('no_content');
  });

  it('reports no_content when a full crawl walked only folders', async () => {
    const find_latest_snapshot = vi.fn().mockResolvedValue(undefined);

    const reason = await classify_empty_run(
      evidence({
        previous_kind_by_file_id: { root: 'folder', sub: 'folder' },
        files_processed: 0,
        find_latest_snapshot,
      }),
    );

    expect(reason).toBe('no_content');
    expect(find_latest_snapshot).toHaveBeenCalledTimes(1);
  });

  it('reports no_changes when a walked file produced no snapshot, without a lookup', async () => {
    const find_latest_snapshot = vi.fn();

    const reason = await classify_empty_run(evidence({ files_processed: 1, find_latest_snapshot }));

    expect(reason).toBe('no_changes');
    expect(find_latest_snapshot).not.toHaveBeenCalled();
  });

  it('reports no_changes when the cursor already knows a file', async () => {
    const find_latest_snapshot = vi.fn();

    const reason = await classify_empty_run(
      evidence({ previous_kind_by_file_id: { f1: 'file' }, find_latest_snapshot }),
    );

    expect(reason).toBe('no_changes');
    expect(find_latest_snapshot).not.toHaveBeenCalled();
  });

  it('reports no_changes when nothing was walked but a snapshot exists in storage', async () => {
    const reason = await classify_empty_run(
      evidence({
        find_latest_snapshot: vi.fn().mockResolvedValue({ snapshot_id: 'snap-1' }),
      }),
    );

    expect(reason).toBe('no_changes');
  });
});
