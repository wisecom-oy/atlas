import { describe, expect, it, vi } from 'vitest';
import type { Container } from 'inversify';
import { MissingGraphPermissionsError } from '@wisecom/atlas-types';
import { create_outlook_api } from '@/outlook-api.factory';
import { create_onedrive_api } from '@/onedrive-api.factory';
import { create_sharepoint_api } from '@/sharepoint-api.factory';

/**
 * Issue #871: an Outlook, OneDrive or SharePoint restore that Microsoft Graph refuses for the whole
 * mailbox, drive or site now ends with the typed error instead of a result that lists one failure
 * per item. SDK callers receive that error as the rejection, unchanged.
 */
const OWNER_ID = '9a1f4d2e-6b3c-4a5e-8d7f-2e3a4b5c6d7e';
const SITE_ID = '00000000-0000-0000-0000-000000000000,11111111-1111-1111-1111-111111111111';

function refusal(): MissingGraphPermissionsError {
  return new MissingGraphPermissionsError('Microsoft Graph returned HTTP 403 accessDenied', {
    permissions: ['Files.ReadWrite.All'],
    status_code: 403,
    graph_code: 'accessDenied',
  });
}

/** A container whose services are looked up by their token's description. */
function container_with(services: Record<string, unknown>): Container {
  return {
    get: (token: symbol) => services[token.description!] ?? {},
    isBound: () => false,
  } as unknown as Container;
}

describe('SDK restore refused for the whole target (issue #871)', () => {
  it('rejects outlook.restore() with the typed error', async () => {
    const error = refusal();
    const container = container_with({
      RestoreUseCase: { restore_snapshot: vi.fn().mockRejectedValue(error) },
    });

    await expect(create_outlook_api('tenant-1', container).restore('snap-1')).rejects.toBe(error);
  });

  it('rejects onedrive.restore() with the typed error', async () => {
    const error = refusal();
    const container = container_with({
      OneDriveRestoreUseCase: { restore_onedrive: vi.fn().mockRejectedValue(error) },
    });

    const run = create_onedrive_api('tenant-1', container).restore(OWNER_ID, {
      snapshotId: 'snap-1',
    });

    await expect(run).rejects.toBe(error);
  });

  it('rejects sharepoint.restore() with the typed error', async () => {
    const error = refusal();
    const container = container_with({
      SharePointRestoreUseCase: { restore_sharepoint: vi.fn().mockRejectedValue(error) },
    });

    const run = create_sharepoint_api('tenant-1', container).restore(SITE_ID, {
      snapshotId: 'sp-snap-1',
    });

    await expect(run).rejects.toBe(error);
  });
});
