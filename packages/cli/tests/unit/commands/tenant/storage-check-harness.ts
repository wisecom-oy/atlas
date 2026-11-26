import { vi } from 'vitest';
import { Command } from 'commander';
import { Container } from 'inversify';
import type { ReactElement } from 'react';
import {
  STORAGE_CHECK_USE_CASE_TOKEN,
  type StorageCheckRequest,
  type StorageCheckResult,
  type StorageCheckUseCase,
  type StorageConditionalWriteCheck,
} from '@wisecom/atlas-types';
import { register_storage_check_command } from '@/commands/tenant/storage-check.command';
import type { KeyValueItem } from '@/ui/components/key-value-list';
import { render_static_view } from '@/ui/render';

/** Shared by the storage-check tests. Each test file mocks `@/ui/render` itself. */
export function lock_capable_bucket(
  conditional_writes: StorageConditionalWriteCheck,
): StorageCheckResult {
  return {
    bucket: 'atlas-tenant-example',
    reachable: true,
    versioning_enabled: true,
    object_lock_enabled: true,
    mode_supported: true,
    conditional_writes,
    lifecycle: { status: 'checked', missing_actions: [] },
  };
}

/** Runs `atlas storage-check` against a stubbed use case and returns the rows it rendered. */
export async function rendered_rows(
  result: StorageCheckResult,
  extra_args: string[] = [],
  requests: (StorageCheckRequest | undefined)[] = [],
): Promise<KeyValueItem[]> {
  const container = new Container();
  container.bind(STORAGE_CHECK_USE_CASE_TOKEN).toConstantValue({
    check_storage: async (_tenant, request) => {
      requests.push(request);
      return result;
    },
  } as StorageCheckUseCase);
  const program = new Command();
  register_storage_check_command(program, () => container);

  await program.parseAsync([
    'node',
    'atlas',
    'storage-check',
    '--tenant',
    'tenant-example',
    ...extra_args,
  ]);

  const view = vi.mocked(render_static_view).mock.calls.at(-1)?.[0] as ReactElement<{
    children: ReactElement<{ items: KeyValueItem[] }>[];
  }>;
  return view.props.children[1]!.props.items;
}

export function row(rows: KeyValueItem[], label: string): KeyValueItem | undefined {
  return rows.find((item) => item.label === label);
}
