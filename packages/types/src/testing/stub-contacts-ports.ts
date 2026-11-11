import type { ContactsDeltaCursor, ContactsSnapshotManifest } from '@/domain/contacts/manifest';
import type { BackupProgressReporter } from '@/ports/backup/use-case.port';
import type {
  ContactFolderDelta,
  ContactsConnector,
  GraphContactFolder,
  GraphContactPayload,
} from '@/ports/contacts/connector.port';
import type {
  ContactsDeltaCursorRepository,
  ContactsManifestRepository,
} from '@/ports/contacts/repository.port';
import type {
  TenantContext,
  TenantContextFactory,
  TenantStorageContext,
} from '@/ports/tenant/context.port';

/** Mutable script for the fake connector: folders, per-folder deltas and failure injection. */
export interface ConnectorScript {
  folders: GraphContactFolder[];
  deltas: Record<string, ContactFolderDelta>;
  failing_delta_folders: Set<string>;
  failing_photo_contacts: Set<string>;
}

/** One recorded delta read: which folder, and the link it was asked to resume from. */
export interface DeltaCall {
  readonly folder_id: string;
  readonly delta_link: string | undefined;
}

export interface FakeConnector {
  readonly connector: ContactsConnector;
  readonly script: ConnectorScript;
  readonly delta_calls: DeltaCall[];
}

/** A contact payload with an id, display name and one example.com address. */
export function contact(id: string, name = `Contact ${id}`): GraphContactPayload {
  return { id, displayName: name, emailAddresses: [{ address: `${id}@example.com` }] };
}

/** A contact folder record. */
export function folder(id: string, display_name: string, path: string[] = []): GraphContactFolder {
  return { id, display_name, path };
}

/** Default two-folder mailbox: a root contacts folder and one child folder. */
export function default_folders(): GraphContactFolder[] {
  return [folder('f-default', 'Contacts'), folder('f-sub', 'Sub', ['Sub'])];
}

/** Scriptable connector. Delta responses are looked up by folder id; photos are absent by default. */
export function fake_connector(): FakeConnector {
  const script: ConnectorScript = {
    folders: default_folders(),
    deltas: {},
    failing_delta_folders: new Set(),
    failing_photo_contacts: new Set(),
  };
  const delta_calls: DeltaCall[] = [];
  const connector: ContactsConnector = {
    list_contact_folders: async () => script.folders,
    fetch_contact_delta: async (_tenant, _mailbox, folder_id, delta_link) => {
      delta_calls.push({ folder_id, delta_link });
      if (script.failing_delta_folders.has(folder_id)) throw new Error('delta unavailable');
      const delta = script.deltas[folder_id];
      if (delta === undefined) throw new Error(`no delta scripted for ${folder_id}`);
      return delta;
    },
    fetch_contact_photo: async (_tenant, _mailbox, _folder, contact_id) => {
      if (script.failing_photo_contacts.has(contact_id)) throw new Error('photo unavailable');
      return undefined;
    },
    list_folder_contacts: async () => [],
    create_contact_folder: async () => {
      throw new Error('create_contact_folder not scripted');
    },
    create_contact: async () => {
      throw new Error('create_contact not scripted');
    },
    upload_contact_photo: async () => {
      throw new Error('upload_contact_photo not scripted');
    },
  };
  return { connector, script, delta_calls };
}

/** Manifest repository that keeps every saved manifest in memory; latest is the last one saved. */
export interface MemoryManifests extends ContactsManifestRepository {
  readonly saved: ContactsSnapshotManifest[];
}

export function memory_manifests(): MemoryManifests {
  const saved: ContactsSnapshotManifest[] = [];
  return {
    saved,
    save: async (_ctx, manifest) => {
      saved.push(manifest);
    },
    find_by_snapshot: async (_ctx, _mailbox, snapshot_id) =>
      saved.find((m) => m.snapshot_id === snapshot_id),
    find_latest_readable: async () => ({ manifest: saved.at(-1), unreadable_keys: [] }),
    list_readable_snapshots_by_mailbox: async () => ({
      manifests: [...saved].reverse(),
      unreadable_keys: [],
    }),
    read_manifest_at: async (_ctx, key) =>
      saved.find((m) => key.endsWith(`/${m.snapshot_id}.json`)),
  };
}

/** Cursor repository that keeps every saved cursor in memory; latest is the last one saved. */
export interface MemoryCursors extends ContactsDeltaCursorRepository {
  readonly saved: ContactsDeltaCursor[];
}

export function memory_cursors(): MemoryCursors {
  const saved: ContactsDeltaCursor[] = [];
  return {
    saved,
    load: async () => saved.at(-1),
    save: async (_ctx, cursor) => {
      saved.push(cursor);
    },
  };
}

/** Progress reporter that records method names so tests can assert on the progress contract. */
export interface RecordingReporter extends BackupProgressReporter {
  readonly calls: string[];
}

export function recording_reporter(): RecordingReporter {
  const calls: string[] = [];
  const record = (name: string) => () => {
    calls.push(name);
  };
  return {
    calls,
    set_status: record('set_status'),
    mark_active: record('mark_active'),
    update_active: record('update_active'),
    update_paging: record('update_paging'),
    set_row_total: record('set_row_total'),
    mark_done: record('mark_done'),
    mark_synced: record('mark_synced'),
    mark_all_pending_interrupted: record('mark_all_pending_interrupted'),
    mark_error: record('mark_error'),
    update_total: record('update_total'),
    finish: record('finish'),
  };
}

/** Tenant factory that hands out the given context; storage-only access is served by `storage_only` when supplied. */
export function tenant_factory_for(
  ctx: TenantContext,
  storage_only?: TenantStorageContext,
): TenantContextFactory {
  return {
    create: async () => ctx,
    create_readonly: async () => ctx,
    create_storage_only: async () => {
      if (storage_only === undefined) {
        throw new Error('create_storage_only not expected in this test');
      }
      return storage_only;
    },
  };
}
