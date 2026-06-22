import { vi } from 'vitest';
import type {
  SharePointSiteConnector,
  SharePointDeltaItem,
  SharePointDeltaCursorRepository,
  SharePointFileVersionIndexRepository,
  SharePointManifestRepository,
  TenantContext,
  TenantContextFactory,
} from '@atlas/types';
import { SharePointBackupService } from '@/services/sharepoint-backup.service';

export function make_file_item(
  id: string,
  overrides: Partial<SharePointDeltaItem> = {},
): SharePointDeltaItem {
  return {
    item_id: id,
    drive_id: 'drive-1',
    kind: 'file',
    file_name: `${id}.docx`,
    parent_path: '/Docs',
    size_bytes: 512,
    deleted: false,
    etag: `etag-${id}`,
    ...overrides,
  };
}

export function make_ctx(): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage: {
      exists: vi.fn().mockResolvedValue(false),
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn(),
      begin_multipart_upload: vi.fn(),
      copy: vi.fn(),
      abort_incomplete_uploads: vi.fn(),
    },
    encrypt: vi.fn((data: Buffer) => data),
    decrypt: vi.fn((data: Buffer) => data),
    create_cipher: vi.fn(),
    destroy: vi.fn(),
  } as unknown as TenantContext;
}

export function make_connector(
  overrides: Partial<SharePointSiteConnector> = {},
): SharePointSiteConnector {
  return {
    list_sites: vi.fn(),
    resolve_site: vi.fn(),
    list_document_libraries: vi
      .fn()
      .mockResolvedValue([{ drive_id: 'drive-1', drive_name: 'Documents' }]),
    fetch_delta: vi.fn().mockResolvedValue({
      drive_id: 'drive-1',
      delta_link: 'https://delta-link',
      items: [],
      reset_detected: false,
    }),
    download_file_content: vi.fn().mockResolvedValue(Buffer.from('data')),
    resolve_download_url: vi.fn(),
    list_file_versions: vi.fn().mockResolvedValue([]),
    download_file_version: vi.fn(),
    ...overrides,
  } as unknown as SharePointSiteConnector;
}

export function make_manifests(): SharePointManifestRepository {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    find_by_snapshot: vi.fn(),
    find_latest_by_site: vi.fn(),
    list_snapshots_by_site: vi.fn(),
  } as unknown as SharePointManifestRepository;
}

export function make_file_indexes(): SharePointFileVersionIndexRepository {
  return {
    find_by_file_id: vi.fn().mockResolvedValue(undefined),
    append_version: vi.fn().mockResolvedValue({ file_id: '', site_id: '', versions: [] }),
    list_by_site: vi.fn(),
  } as unknown as SharePointFileVersionIndexRepository;
}

export function make_cursors(): SharePointDeltaCursorRepository {
  return {
    load: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
  } as unknown as SharePointDeltaCursorRepository;
}

export function make_service(
  overrides: {
    connector?: SharePointSiteConnector;
    manifests?: SharePointManifestRepository;
    file_indexes?: SharePointFileVersionIndexRepository;
    cursors?: SharePointDeltaCursorRepository;
  } = {},
): SharePointBackupService {
  const ctx = make_ctx();
  const factory: TenantContextFactory = { create: vi.fn().mockResolvedValue(ctx) };
  const connector = overrides.connector ?? make_connector();
  const manifests = overrides.manifests ?? make_manifests();
  const file_indexes = overrides.file_indexes ?? make_file_indexes();
  const cursors = overrides.cursors ?? make_cursors();

  return new (SharePointBackupService as unknown as new (
    factory: TenantContextFactory,
    connector: SharePointSiteConnector,
    manifests: SharePointManifestRepository,
    file_indexes: SharePointFileVersionIndexRepository,
    cursors: SharePointDeltaCursorRepository,
  ) => SharePointBackupService)(factory, connector, manifests, file_indexes, cursors);
}
