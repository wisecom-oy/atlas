import { describe, expect, it, vi } from 'vitest';
import type { Container } from 'inversify';
import {
  BACKUP_USE_CASE_TOKEN,
  VERIFICATION_USE_CASE_TOKEN,
  RESTORE_USE_CASE_TOKEN,
  SAVE_USE_CASE_TOKEN,
  ONEDRIVE_BACKUP_USE_CASE_TOKEN,
  ONEDRIVE_VERIFICATION_USE_CASE_TOKEN,
  ONEDRIVE_RESTORE_USE_CASE_TOKEN,
  ONEDRIVE_SAVE_USE_CASE_TOKEN,
  SHAREPOINT_SITE_TREE_BACKUP_USE_CASE_TOKEN,
  SHAREPOINT_VERIFICATION_USE_CASE_TOKEN,
  SHAREPOINT_RESTORE_USE_CASE_TOKEN,
  SHAREPOINT_SAVE_USE_CASE_TOKEN,
} from '@wisecom/atlas-types';
import { create_outlook_api } from '@/outlook-api.factory';
import { create_onedrive_api } from '@/onedrive-api.factory';
import { create_sharepoint_api } from '@/sharepoint-api.factory';

const TENANT_ID = 'tenant-1';
const OWNER_ID = 'owner-1';

function container_with(...entries: [symbol, unknown][]): Container {
  const services = new Map(entries);
  return {
    get: vi.fn((requested: symbol) => services.get(requested) ?? {}),
  } as unknown as Container;
}

function expect_adapted_options(
  options: Record<string, unknown>,
  on_progress: unknown,
  controller: AbortController,
): void {
  (options.on_progress as (event: object) => void)({
    operation: 'backup',
    workload: 'onedrive',
    phase: 'processing',
    processed: 1,
  });
  expect(on_progress).toHaveBeenCalledOnce();
  expect(options).not.toHaveProperty('onProgress');
  expect(options).not.toHaveProperty('signal');
  const should_interrupt = options.should_interrupt as () => boolean;
  expect(should_interrupt()).toBe(false);
  controller.abort();
  expect(should_interrupt()).toBe(true);
}

describe('SDK progress and cancellation option adaptation', () => {
  it('adapts Outlook backup onProgress and signal to internal hooks', async () => {
    const sync_mailbox = vi.fn().mockResolvedValue({ interrupted: false });
    const api = create_outlook_api(
      TENANT_ID,
      container_with([BACKUP_USE_CASE_TOKEN, { sync_mailbox }]),
    );
    const controller = new AbortController();
    const on_progress = vi.fn();

    await api.backup(OWNER_ID, {
      onProgress: on_progress,
      signal: controller.signal,
    });

    expect_adapted_options(sync_mailbox.mock.calls[0]![2], on_progress, controller);
  });

  it('adapts OneDrive backup onProgress and signal to internal hooks', async () => {
    const backup_onedrive = vi.fn().mockResolvedValue({ interrupted: false });
    const api = create_onedrive_api(
      TENANT_ID,
      container_with([ONEDRIVE_BACKUP_USE_CASE_TOKEN, { backup_onedrive }]),
    );
    const controller = new AbortController();
    const on_progress = vi.fn();

    await api.backup(OWNER_ID, {
      onProgress: on_progress,
      signal: controller.signal,
    });

    expect_adapted_options(backup_onedrive.mock.calls[0]![2], on_progress, controller);
  });

  it('adapts SharePoint backup onProgress and signal to internal hooks', async () => {
    const backup_site_tree = vi.fn().mockResolvedValue([{ interrupted: false }]);
    const api = create_sharepoint_api(
      TENANT_ID,
      container_with([SHAREPOINT_SITE_TREE_BACKUP_USE_CASE_TOKEN, { backup_site_tree }]),
    );
    const controller = new AbortController();
    const on_progress = vi.fn();

    await api.backup(OWNER_ID, {
      onProgress: on_progress,
      signal: controller.signal,
    });

    expect_adapted_options(backup_site_tree.mock.calls[0]![2], on_progress, controller);
  });

  it('adapts Outlook verify, restore, and save options', async () => {
    const verify_snapshot_integrity = vi.fn().mockResolvedValue({ interrupted: false });
    const restore_snapshot = vi.fn().mockResolvedValue({ interrupted: false });
    const save_snapshot = vi.fn().mockResolvedValue({ interrupted: false });
    const api = create_outlook_api(
      TENANT_ID,
      container_with(
        [VERIFICATION_USE_CASE_TOKEN, { verify_snapshot_integrity }],
        [RESTORE_USE_CASE_TOKEN, { restore_snapshot }],
        [SAVE_USE_CASE_TOKEN, { save_snapshot }],
      ),
    );
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const callbacks = [vi.fn(), vi.fn(), vi.fn()];

    await api.verify('snap-1', {
      onProgress: callbacks[0],
      signal: controllers[0].signal,
    });
    await api.restore('snap-1', {
      onProgress: callbacks[1],
      signal: controllers[1].signal,
    });
    await api.save('snap-1', {
      onProgress: callbacks[2],
      signal: controllers[2].signal,
    });

    expect_adapted_options(
      verify_snapshot_integrity.mock.calls[0]![2],
      callbacks[0],
      controllers[0],
    );
    expect_adapted_options(restore_snapshot.mock.calls[0]![2], callbacks[1], controllers[1]);
    expect_adapted_options(save_snapshot.mock.calls[0]![2], callbacks[2], controllers[2]);
  });

  it('adapts OneDrive verify, restore, and save options', async () => {
    const verify_onedrive_snapshot = vi.fn().mockResolvedValue({ interrupted: false });
    const restore_onedrive = vi.fn().mockResolvedValue({ interrupted: false });
    const save_snapshot = vi.fn().mockResolvedValue({ interrupted: false });
    const api = create_onedrive_api(
      TENANT_ID,
      container_with(
        [ONEDRIVE_VERIFICATION_USE_CASE_TOKEN, { verify_onedrive_snapshot }],
        [ONEDRIVE_RESTORE_USE_CASE_TOKEN, { restore_onedrive }],
        [ONEDRIVE_SAVE_USE_CASE_TOKEN, { save_snapshot }],
      ),
    );
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const callbacks = [vi.fn(), vi.fn(), vi.fn()];

    await api.verify(OWNER_ID, 'snap-1', {
      onProgress: callbacks[0],
      signal: controllers[0].signal,
    });
    await api.restore(OWNER_ID, {
      snapshot_id: 'snap-1',
      onProgress: callbacks[1],
      signal: controllers[1].signal,
    });
    await api.save(OWNER_ID, {
      snapshot_id: 'snap-1',
      onProgress: callbacks[2],
      signal: controllers[2].signal,
    });

    expect_adapted_options(
      verify_onedrive_snapshot.mock.calls[0]![3],
      callbacks[0],
      controllers[0],
    );
    expect_adapted_options(restore_onedrive.mock.calls[0]![2], callbacks[1], controllers[1]);
    expect_adapted_options(save_snapshot.mock.calls[0]![2], callbacks[2], controllers[2]);
  });

  it('adapts SharePoint verify, restore, and save options', async () => {
    const verify_sharepoint_snapshot = vi.fn().mockResolvedValue({ interrupted: false });
    const restore_sharepoint = vi.fn().mockResolvedValue({ interrupted: false });
    const save_snapshot = vi.fn().mockResolvedValue({ interrupted: false });
    const api = create_sharepoint_api(
      TENANT_ID,
      container_with(
        [SHAREPOINT_VERIFICATION_USE_CASE_TOKEN, { verify_sharepoint_snapshot }],
        [SHAREPOINT_RESTORE_USE_CASE_TOKEN, { restore_sharepoint }],
        [SHAREPOINT_SAVE_USE_CASE_TOKEN, { save_snapshot }],
      ),
    );
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const callbacks = [vi.fn(), vi.fn(), vi.fn()];

    await api.verify(OWNER_ID, 'snap-1', {
      onProgress: callbacks[0],
      signal: controllers[0].signal,
    });
    await api.restore(OWNER_ID, {
      snapshot_id: 'snap-1',
      onProgress: callbacks[1],
      signal: controllers[1].signal,
    });
    await api.save(OWNER_ID, {
      snapshot_id: 'snap-1',
      onProgress: callbacks[2],
      signal: controllers[2].signal,
    });

    expect_adapted_options(
      verify_sharepoint_snapshot.mock.calls[0]![3],
      callbacks[0],
      controllers[0],
    );
    expect_adapted_options(restore_sharepoint.mock.calls[0]![2], callbacks[1], controllers[1]);
    expect_adapted_options(save_snapshot.mock.calls[0]![2], callbacks[2], controllers[2]);
  });
  it('isolates operation results from consumer progress callback errors', async () => {
    const backup_onedrive = vi.fn(async (_tenant_id, _owner_id, options) => {
      options.on_progress({
        operation: 'backup',
        workload: 'onedrive',
        phase: 'processing',
        processed: 1,
      });
      return { interrupted: false };
    });
    const api = create_onedrive_api(
      TENANT_ID,
      container_with([ONEDRIVE_BACKUP_USE_CASE_TOKEN, { backup_onedrive }]),
    );

    await expect(
      api.backup(OWNER_ID, {
        onProgress: () => {
          throw new Error('consumer failed');
        },
      }),
    ).resolves.toEqual({ interrupted: false });
  });
});
