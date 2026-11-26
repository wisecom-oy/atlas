import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageCheckRequest } from '@wisecom/atlas-types';
import { lock_capable_bucket, rendered_rows, row } from './storage-check-harness';

vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => {}) }));

describe('atlas storage-check', () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.clearAllMocks();
  });

  it('reports a backend that refuses both conditional writes as ready', async () => {
    const rows = await rendered_rows(lock_capable_bucket({ support: 'supported' }));

    expect(row(rows, 'Conditional writes')).toEqual({
      label: 'Conditional writes',
      value: 'supported',
      color: 'green',
    });
    expect(row(rows, 'Status')?.value).toBe('ready');
    expect(process.exitCode).toBeUndefined();
  });

  it('fails the check and names the ignored condition when the backend accepts the writes', async () => {
    const rows = await rendered_rows(
      lock_capable_bucket({
        support: 'ignored',
        detail: 'the backend accepted a compare-and-swap (If-Match) with a stale ETag',
        violations: ['stale_if_match'],
      }),
    );

    expect(row(rows, 'Conditional writes')).toEqual({
      label: 'Conditional writes',
      value: 'NOT ENFORCED: the backend accepted a compare-and-swap (If-Match) with a stale ETag',
      color: 'red',
    });
    expect(row(rows, 'Status')?.value).toBe('not-ready');
    expect(process.exitCode).toBe(1);
  });

  it('fails the check when the backend refuses a compare-and-swap with the current ETag', async () => {
    const rows = await rendered_rows(
      lock_capable_bucket({
        support: 'ignored',
        detail: 'the backend refused a compare-and-swap (If-Match) with the current ETag',
        violations: ['current_if_match'],
      }),
    );

    expect(row(rows, 'Conditional writes')?.value).toBe(
      'NOT ENFORCED: the backend refused a compare-and-swap (If-Match) with the current ETag',
    );
    expect(row(rows, 'Status')?.value).toBe('not-ready');
    expect(process.exitCode).toBe(1);
  });

  it('says why the probe did not run and leaves the verdict to the other checks', async () => {
    const rows = await rendered_rows(
      lock_capable_bucket({ support: 'not_probed', detail: 'the bucket does not exist yet' }),
    );

    expect(row(rows, 'Conditional writes')).toEqual({
      label: 'Conditional writes',
      value: 'not probed (the bucket does not exist yet)',
      color: 'yellow',
    });
    expect(row(rows, 'Status')?.value).toBe('ready');
    expect(process.exitCode).toBeUndefined();
  });

  it('reports the missing lifecycle action without changing the readiness verdict', async () => {
    const rows = await rendered_rows({
      ...lock_capable_bucket({ support: 'supported' }),
      lifecycle: {
        status: 'checked',
        missing_actions: [
          {
            rule_id: 'atlas-housekeeping',
            action: 'AbortIncompleteMultipartUpload',
            fixed_by_apply: false,
          },
          { rule_id: 'atlas-state-versions-teams', action: 'Prefix', fixed_by_apply: true },
        ],
      },
    });

    expect(row(rows, 'Lifecycle rules')).toEqual({
      label: 'Lifecycle rules',
      value:
        'missing Atlas actions: atlas-state-versions-teams/Prefix (fix with --apply-lifecycle); ' +
        'atlas-housekeeping/AbortIncompleteMultipartUpload ' +
        '(--apply-lifecycle keeps these rules as they are)',
      color: 'yellow',
    });
    expect(row(rows, 'Status')?.value).toBe('ready');
    expect(process.exitCode).toBeUndefined();
  });

  it('asks for no lifecycle change and shows no update row without --apply-lifecycle', async () => {
    const requests: (StorageCheckRequest | undefined)[] = [];
    const rows = await rendered_rows(lock_capable_bucket({ support: 'supported' }), [], requests);

    expect(requests).toEqual([{}]);
    expect(row(rows, 'Lifecycle update')).toBeUndefined();
  });

  it('passes --apply-lifecycle through and names the rules it added (issue #918)', async () => {
    const requests: (StorageCheckRequest | undefined)[] = [];
    const rows = await rendered_rows(
      {
        ...lock_capable_bucket({ support: 'supported' }),
        lifecycle_update: {
          status: 'applied',
          added_rule_ids: ['atlas-state-versions-outlook-leases', 'atlas-state-versions-teams'],
          replaced_rule_ids: ['atlas-state-versions-onedrive'],
        },
      },
      ['--apply-lifecycle'],
      requests,
    );

    expect(requests).toEqual([{ apply_lifecycle: true }]);
    expect(row(rows, 'Lifecycle update')).toEqual({
      label: 'Lifecycle update',
      value:
        'added 2 rules: atlas-state-versions-outlook-leases, atlas-state-versions-teams; ' +
        'reset 1 rule: atlas-state-versions-onedrive',
      color: 'green',
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 1 when the lifecycle update failed, even on a ready bucket', async () => {
    const rows = await rendered_rows(
      {
        ...lock_capable_bucket({ support: 'supported' }),
        lifecycle_update: {
          status: 'failed',
          detail: 'access denied (requires s3:PutLifecycleConfiguration)',
        },
      },
      ['--apply-lifecycle'],
    );

    expect(row(rows, 'Lifecycle update')).toEqual({
      label: 'Lifecycle update',
      value: 'FAILED: access denied (requires s3:PutLifecycleConfiguration)',
      color: 'red',
    });
    expect(row(rows, 'Status')?.value).toBe('ready');
    expect(process.exitCode).toBe(1);
  });
});
