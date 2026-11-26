/**
 * Issue #974: `atlas storage-check` names the writer-exclusion mode, and only the default mode
 * treats a backend that does not enforce conditional writes as not ready.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageCheckResult, WriterExclusionMode } from '@wisecom/atlas-types';
import { lock_capable_bucket, rendered_rows, row } from './storage-check-harness';

vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => {}) }));

const IGNORED = {
  support: 'ignored',
  detail: 'the backend accepted a create-only write',
  violations: ['create_only'],
} as const;

function in_mode(
  mode: WriterExclusionMode | undefined,
  conditional_writes: StorageCheckResult['conditional_writes'],
): StorageCheckResult {
  return { ...lock_capable_bucket(conditional_writes), writer_exclusion: mode };
}

describe('atlas storage-check writer exclusion (issue #974)', () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.clearAllMocks();
  });

  it('keeps refusing a backend that ignores the conditions in the default mode', async () => {
    const rows = await rendered_rows(in_mode('storage_lease', IGNORED));

    expect(row(rows, 'Writer exclusion')?.value).toBe('owner leases in the bucket');
    expect(row(rows, 'Conditional writes')?.color).toBe('red');
    expect(row(rows, 'Status')?.value).toBe('not-ready');
    expect(process.exitCode).toBe(1);
  });

  it('reads a result without the field as the default mode', async () => {
    const rows = await rendered_rows(in_mode(undefined, IGNORED));

    expect(row(rows, 'Writer exclusion')?.value).toBe('owner leases in the bucket');
    expect(row(rows, 'Status')?.value).toBe('not-ready');
  });

  it.each([
    ['ignores', IGNORED],
    ['rejects', { support: 'not_probed', detail: 'the probe failed: NotImplemented' } as const],
  ])(
    'reports single-writer mode as ready on a backend that %s the conditions',
    async (_name, check) => {
      const rows = await rendered_rows(in_mode('single_writer', check));

      expect(row(rows, 'Writer exclusion')).toEqual({
        label: 'Writer exclusion',
        value: 'single writer (ATLAS_SINGLE_WRITER): one Atlas process per tenant',
        color: 'yellow',
      });
      expect(row(rows, 'Conditional writes')?.value).toContain('not sent in this mode');
      expect(row(rows, 'Status')?.value).toBe('ready');
      expect(process.exitCode).toBeUndefined();
    },
  );

  it('says when the backend would support the default owner lease', async () => {
    const rows = await rendered_rows(in_mode('single_writer', { support: 'supported' }));

    expect(row(rows, 'Writer exclusion')?.value).toContain(
      'this backend enforces conditional writes, so the default owner lease would work here',
    );
  });

  it('names a host-supplied exclusion', async () => {
    const rows = await rendered_rows(in_mode('host_exclusion', IGNORED));

    expect(row(rows, 'Writer exclusion')?.value).toBe('host-supplied (ownerExclusion)');
    expect(row(rows, 'Status')?.value).toBe('ready');
  });
});
