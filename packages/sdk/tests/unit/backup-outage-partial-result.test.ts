/* eslint-disable @typescript-eslint/naming-convention */
import { describe, it, expect, vi } from 'vitest';
import type { Container } from 'inversify';
import { GraphUnavailableError, ThrottledError } from '@wisecom/atlas-types';
import { create_outlook_api } from '@/outlook-api.factory';
import { create_onedrive_api } from '@/onedrive-api.factory';

/**
 * Issue #869. A backup that a Graph outage stopped rejects, and its caller got no result, so no
 * snapshot ID and no list of failed folders. The rejection carries the run's result as
 * `partial_result`, camelised like a resolved backup.
 */
const OWNER = { object_id: '9a1f4d2e-6b3c-4a5e-8d7f-2e3a4b5c6d7e', email: 'john.doe@example.com' };

function container_with(services: Record<string, unknown>): Container {
  return {
    get: (token: symbol) => services[token.description!] ?? {},
  } as unknown as Container;
}

function outage_with(partial_result: unknown): GraphUnavailableError {
  return new GraphUnavailableError(
    'Microsoft Graph was unavailable after 12 retries over 1411 s: HTTP 503',
    { retries: 12, elapsed_ms: 1_411_000 },
    { status_code: 503, partial_result },
  );
}

describe('backup rejected by a Graph outage', () => {
  it('outlook.backup carries the camelCase result with the transient folder failures', async () => {
    const sync_mailbox = vi.fn().mockRejectedValue(
      outage_with({
        snapshot: { id: 'snap-1', object_count: 0 },
        summary: {
          completed_folder_count: 0,
          folder_failures: [
            {
              folder_id: 'folder-1',
              folder_path: 'Inbox',
              message: 'Microsoft Graph was unavailable',
              code: 'ATLAS_GRAPH_UNAVAILABLE',
              transient: true,
            },
          ],
        },
      }),
    );
    const api = create_outlook_api(
      'tenant-1',
      container_with({
        BackupUseCase: { sync_mailbox },
        UserIdentityResolver: { resolve_user: vi.fn(async () => OWNER) },
      }),
    );

    const error = await api.backup('john.doe@example.com').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(GraphUnavailableError);
    expect(error).toMatchObject({ code: 'ATLAS_GRAPH_UNAVAILABLE' });
    expect((error as GraphUnavailableError).partial_result).toEqual({
      snapshot: { id: 'snap-1', objectCount: 0 },
      summary: {
        completedFolderCount: 0,
        folderFailures: [
          {
            folderId: 'folder-1',
            folderPath: 'Inbox',
            message: 'Microsoft Graph was unavailable',
            code: 'ATLAS_GRAPH_UNAVAILABLE',
            transient: true,
          },
        ],
      },
    });
  });

  it('onedrive.backup camelises a throttle rejection the same way', async () => {
    const backup_onedrive = vi.fn().mockRejectedValue(
      new ThrottledError('kept throttling', 30_000, {
        partial_result: { snapshot_id: 'snap-2' },
      }),
    );
    const api = create_onedrive_api(
      'tenant-1',
      container_with({
        OneDriveBackupUseCase: { backup_onedrive },
        UserIdentityResolver: { resolve_user: vi.fn(async () => OWNER) },
      }),
    );

    const error = await api.backup('john.doe@example.com').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ThrottledError);
    expect((error as ThrottledError).partial_result).toEqual({ snapshotId: 'snap-2' });
  });

  it('leaves an outage without a result untouched', async () => {
    const outage = new GraphUnavailableError('down', { retries: 12, elapsed_ms: 1 });
    const api = create_outlook_api(
      'tenant-1',
      container_with({
        BackupUseCase: { sync_mailbox: vi.fn().mockRejectedValue(outage) },
        UserIdentityResolver: { resolve_user: vi.fn(async () => OWNER) },
      }),
    );

    await expect(api.backup('john.doe@example.com')).rejects.toBe(outage);
    expect(outage.partial_result).toBeUndefined();
  });
});
