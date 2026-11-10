import { describe, it, expect } from 'vitest';
import type { OneDriveDrive, OneDriveManifestEntry } from '@wisecom/atlas-types';
import { accumulate_drive_result } from '@/services/backup/drive-result-accumulator';
import type {
  DriveScanAccumulators,
  SingleDriveResult,
} from '@/services/backup/backup-drive-processor';

/**
 * Issue #626. `push(...drive_result.entries)` passes every entry as a call argument and throws
 * `RangeError` past V8's argument limit (about 125k on Node 22), failing a large drive's run.
 */
const BEYOND_ARGUMENT_LIMIT = 300_000;

function make_entry(i: number): OneDriveManifestEntry {
  return {
    file_id: `f-${i}`,
    drive_id: 'd1',
    file_name: `file-${i}.txt`,
    parent_path: '/',
    size_bytes: 1,
    backup_at: '2026-01-01T00:00:00.000Z',
    change_type: 'created',
  };
}

function make_accumulators(): DriveScanAccumulators {
  return {
    entries: [make_entry(-1)],
    files_stored: 0,
    files_deduplicated: 0,
    deleted_items: 0,
    failed_items: {},
    errors: [],
    interrupted: false,
    recrawls: [],
  } as unknown as DriveScanAccumulators;
}

describe('accumulate_drive_result', () => {
  it('folds a drive with more entries than the engine argument limit', () => {
    const accumulators = make_accumulators();
    const entries = Array.from({ length: BEYOND_ARGUMENT_LIMIT }, (_, i) => make_entry(i));
    const drive_result = {
      entries,
      files_stored: BEYOND_ARGUMENT_LIMIT,
      files_deduplicated: 0,
      deleted_items: 0,
      failed_items: {},
      errors: [],
      interrupted: false,
      delta_link: 'https://delta/next',
    } as unknown as SingleDriveResult;
    const links: Record<string, string> = {};

    accumulate_drive_result(
      accumulators,
      links,
      { drive_id: 'd1' } as OneDriveDrive,
      drive_result,
      undefined,
    );

    expect(accumulators.entries).toHaveLength(BEYOND_ARGUMENT_LIMIT + 1);
    expect(accumulators.entries.at(-1)?.file_id).toBe(`f-${BEYOND_ARGUMENT_LIMIT - 1}`);
    expect(accumulators.files_stored).toBe(BEYOND_ARGUMENT_LIMIT);
    expect(links).toEqual({ d1: 'https://delta/next' });
  });
});
