/**
 * Issue #38: `deleteOwnerData` given the uppercase spelling of an owner reported
 * success and left the lowercase tree behind -- an erasure that erased nothing.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import 'reflect-metadata';
import { Container } from 'inversify';
import { TENANT_CONTEXT_FACTORY_TOKEN } from '@wisecom/atlas-types';
import type { TenantContextFactory } from '@wisecom/atlas-types';
import { OneDriveDeletionService } from '@/services/deletion/onedrive-deletion.service';
import { SharePointDeletionService } from '@/services/deletion/sharepoint-deletion.service';

const LOWER = '75a21b57-4d82-4f42-9ccc-7c231c30f78c';
const UPPER = LOWER.toUpperCase();
const SITE_LOWER = 'contoso.sharepoint.com,site-guid,web-guid';

/** The slice of storage a deletion sweep touches, with calls recorded. */
interface RecordingStorage {
  delete: Mock;
  delete_version: Mock;
  list: Mock;
  list_versions: Mock;
}

function make_storage(): RecordingStorage {
  return {
    delete: vi.fn().mockResolvedValue(undefined),
    delete_version: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    list_versions: vi.fn().mockResolvedValue([]),
  };
}

describe('deletion prefixes ignore identifier case', () => {
  let storage: RecordingStorage;
  let container: Container;

  beforeEach(() => {
    storage = make_storage();
    const factory = {
      create: vi.fn(),
      create_readonly: vi.fn(),
      create_storage_only: vi.fn().mockResolvedValue({ storage }),
    } as unknown as TenantContextFactory;

    container = new Container();
    container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(factory);
    container.bind(OneDriveDeletionService).toSelf();
    container.bind(SharePointDeletionService).toSelf();
  });

  const swept = (): string[] => storage.list_versions.mock.calls.map(([scope]) => scope as string);

  it('sweeps the lowercase owner tree when handed the uppercase spelling', async () => {
    await container.get(OneDriveDeletionService).delete_owner_data('t', UPPER);

    expect(swept()).toEqual([
      `onedrive/manifests/${LOWER}/`,
      `onedrive/data/${LOWER}/`,
      `onedrive/index/${LOWER}/`,
      `onedrive/_meta/${LOWER}/`,
      `onedrive/staging/${LOWER}/`,
    ]);
    expect(swept().some((scope) => scope.includes(UPPER))).toBe(false);
  });

  it('sweeps the lowercase site tree when handed a mixed-case site id', async () => {
    await container
      .get(SharePointDeletionService)
      .delete_site_data('t', 'Contoso.SharePoint.com,SITE-GUID,WEB-GUID');

    expect(swept()[0]).toBe(`sharepoint/manifests/${SITE_LOWER}/`);
  });

  it('addresses one snapshot manifest regardless of spelling', async () => {
    await container.get(OneDriveDeletionService).delete_snapshot('t', UPPER, 'snap-1');

    expect(swept()).toEqual([`onedrive/manifests/${LOWER}/snap-1.json`]);
  });
});
