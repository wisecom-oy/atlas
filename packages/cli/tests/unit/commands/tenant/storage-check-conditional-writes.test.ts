/**
 * Issue #623: the owner lease only excludes a second run on a backend that refuses conditional
 * writes, so `storage-check` reports the probe and fails the check when the backend ignores them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { Container } from 'inversify';
import type { ReactElement } from 'react';
import {
  STORAGE_CHECK_USE_CASE_TOKEN,
  type StorageCheckResult,
  type StorageCheckUseCase,
  type StorageConditionalWriteCheck,
} from '@wisecom/atlas-types';
import { register_storage_check_command } from '@/commands/tenant/storage-check.command';
import type { KeyValueItem } from '@/ui/components/key-value-list';
import { render_static_view } from '@/ui/render';

vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => {}) }));

function lock_capable_bucket(conditional_writes: StorageConditionalWriteCheck): StorageCheckResult {
  return {
    bucket: 'atlas-tenant-example',
    reachable: true,
    versioning_enabled: true,
    object_lock_enabled: true,
    mode_supported: true,
    conditional_writes,
  };
}

/** Runs `atlas storage-check` against a stubbed use case and returns the rows it rendered. */
async function rendered_rows(result: StorageCheckResult): Promise<KeyValueItem[]> {
  const container = new Container();
  container
    .bind(STORAGE_CHECK_USE_CASE_TOKEN)
    .toConstantValue({ check_storage: async () => result } as StorageCheckUseCase);
  const program = new Command();
  register_storage_check_command(program, () => container);

  await program.parseAsync(['node', 'atlas', 'storage-check', '--tenant', 'tenant-example']);

  const view = vi.mocked(render_static_view).mock.calls.at(-1)?.[0] as ReactElement<{
    children: ReactElement<{ items: KeyValueItem[] }>[];
  }>;
  return view.props.children[1]!.props.items;
}

function row(rows: KeyValueItem[], label: string): KeyValueItem | undefined {
  return rows.find((item) => item.label === label);
}

describe('atlas storage-check conditional writes (issue #623)', () => {
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
        detail: 'the backend accepted a write with If-Match (compare-and-swap)',
      }),
    );

    expect(row(rows, 'Conditional writes')).toEqual({
      label: 'Conditional writes',
      value: 'IGNORED: the backend accepted a write with If-Match (compare-and-swap)',
      color: 'red',
    });
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
});
