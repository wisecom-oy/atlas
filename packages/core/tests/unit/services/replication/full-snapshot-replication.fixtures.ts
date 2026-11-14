import { vi } from 'vitest';
import type {
  CalendarSnapshotManifest,
  ContactsSnapshotManifest,
  ManifestRepository,
  StorageTarget,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { UnreadableContentError } from '@wisecom/atlas-types';
import type { InMemoryTenantContext } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { FullSnapshotReplicationService } from '@/services/replication/full-snapshot-replication.service';
import { ReplicationService } from '@/services/replication/replication.service';
import type { AtlasConfig } from '@/utils/config';

export const TENANT = 'tenant-1';
const CONFIG = { encryption_passphrase: 'p' } as unknown as AtlasConfig;

/** A contacts or calendar snapshot as a backup leaves it: the manifest and the keys it names. */
export interface SeededSnapshot<TManifest> {
  readonly manifest: TManifest;
  readonly manifest_key: string;
  readonly object_keys: readonly string[];
}

/** A contacts snapshot of one contact with a photo. */
export function contacts_snapshot(
  mailbox: string,
  n: number,
): SeededSnapshot<ContactsSnapshotManifest> {
  const snapshot_id = `ct-snap-${n}-a`;
  const data = `contacts/data/${mailbox}/contact-${n}`;
  const photo = `contacts/photos/${mailbox}/photo-${n}`;
  const manifest: ContactsSnapshotManifest = {
    id: snapshot_id,
    tenant_id: TENANT,
    mailbox_id: mailbox,
    snapshot_id,
    created_at: new Date(n * 1000).toISOString(),
    total_contacts: 1,
    total_size_bytes: 4,
    folders: [{ folder_id: 'f', display_name: 'Contacts', path: [] }],
    entries: [
      {
        contact_id: `c-${n}`,
        folder_id: 'f',
        storage_key: data,
        checksum: 'x',
        size_bytes: 4,
        photo_storage_key: photo,
      },
    ],
  };
  return {
    manifest,
    manifest_key: `contacts/manifests/${mailbox}/${snapshot_id}.json`,
    object_keys: [data, photo],
  };
}

/** A calendar snapshot of one event with one attachment. */
export function calendar_snapshot(
  mailbox: string,
  n: number,
): SeededSnapshot<CalendarSnapshotManifest> {
  const snapshot_id = `cal-snap-${n}-a`;
  const data = `calendar/data/${mailbox}/event-${n}`;
  const attachment = `calendar/attachments/${mailbox}/file-${n}`;
  const manifest: CalendarSnapshotManifest = {
    id: snapshot_id,
    tenant_id: TENANT,
    mailbox_id: mailbox,
    snapshot_id,
    created_at: new Date(n * 1000).toISOString(),
    total_events: 1,
    total_size_bytes: 4,
    calendars: [{ calendar_id: 'cal', display_name: 'Calendar', is_default: true }],
    entries: [
      {
        event_id: `e-${n}`,
        calendar_id: 'cal',
        event_type: 'singleInstance',
        storage_key: data,
        checksum: 'x',
        size_bytes: 4,
        attachments: [
          {
            attachment_id: `a-${n}`,
            name: 'file',
            is_inline: false,
            storage_key: attachment,
            checksum: 'x',
            size_bytes: 4,
          },
        ],
      },
    ],
  };
  return {
    manifest,
    manifest_key: `calendar/manifests/${mailbox}/${snapshot_id}.json`,
    object_keys: [data, attachment],
  };
}

/** Puts the tenant key, the snapshots' objects and their manifests into a bucket. */
export function seed(
  bucket: InMemoryTenantContext,
  snapshots: readonly SeededSnapshot<unknown>[],
): void {
  bucket.set_raw('_meta/dek.enc', Buffer.from('wrapped-dek'));
  for (const snapshot of snapshots) {
    for (const key of snapshot.object_keys) bucket.set_raw(key, Buffer.from(`body:${key}`));
    bucket.set_raw(snapshot.manifest_key, Buffer.from(`manifest:${snapshot.manifest_key}`));
  }
}

/**
 * The manifest repositories the service reads through. A manifest is found only in a bucket that
 * holds its key, as the real repositories behave; a key in `damaged` raises as a damaged one does.
 */
export function manifest_readers(
  snapshots: readonly SeededSnapshot<unknown>[],
  damaged: ReadonlySet<string> = new Set(),
): { readonly contacts: never; readonly calendar: never } {
  const by_key = new Map(snapshots.map((s) => [s.manifest_key, s.manifest]));
  const reader = {
    read_manifest_at: async (ctx: TenantContext, key: string) => {
      if (!(await ctx.storage.exists(key))) return undefined;
      if (damaged.has(key)) throw new UnreadableContentError(`${key} failed to decrypt`);
      return by_key.get(key);
    },
  } as never;
  return { contacts: reader, calendar: reader };
}

/** Contacts and calendar replication over repositories that hold no snapshot. */
export function no_full_snapshots(
  validate_dek: ConstructorParameters<typeof FullSnapshotReplicationService>[2],
  config: ConstructorParameters<typeof FullSnapshotReplicationService>[3],
): FullSnapshotReplicationService {
  const none = { read_manifest_at: async () => undefined } as never;
  return new FullSnapshotReplicationService(none, none, validate_dek, config);
}

/** A replica bucket as a storage target. */
export function target_over(bucket: InMemoryTenantContext, target_id: string): StorageTarget {
  return {
    target_id,
    endpoint: 'http://replica.local',
    create_context: vi.fn(async () => bucket.ctx),
  } as unknown as StorageTarget;
}

/**
 * The real replication service over a primary bucket holding no Outlook snapshot, with real
 * contacts and calendar replication reading `snapshots` through the repositories above.
 */
export function replication_service(
  primary: InMemoryTenantContext,
  snapshots: readonly SeededSnapshot<unknown>[],
  damaged?: ReadonlySet<string>,
): ReplicationService {
  const readers = manifest_readers(snapshots, damaged);
  const validate_dek = vi.fn(async () => undefined);
  const tenant_factory = {
    create: vi.fn(async () => primary.ctx),
    create_readonly: vi.fn(async () => primary.ctx),
  } as unknown as TenantContextFactory;
  const no_outlook = {
    list_by_owner: vi.fn(async () => []),
    list_all_manifests: vi.fn(async () => []),
  } as unknown as ManifestRepository;
  const no_drive = {
    rehydrate_all_owners: vi.fn(async () => empty_result('0-owners')),
    rehydrate_all_sites: vi.fn(async () => empty_result('0-sites')),
  } as never;
  return new ReplicationService(
    tenant_factory,
    no_outlook,
    CONFIG,
    validate_dek,
    vi.fn(() => ({}) as StorageTarget) as never,
    no_drive,
    no_drive,
    new FullSnapshotReplicationService(readers.contacts, readers.calendar, validate_dek, CONFIG),
  );
}

function empty_result(snapshot_id: string): unknown {
  return {
    snapshot_id,
    target_id: 'offsite',
    status: 'COMPLETED',
    objects_total: 0,
    objects_copied: 0,
    objects_skipped: 0,
    objects_failed: 0,
    bytes_copied: 0,
    elapsed_ms: 0,
    errors: [],
    verification_status: 'SKIPPED',
  };
}

/** The keys of a bucket under the contacts and calendar trees. */
export function workload_keys(bucket: InMemoryTenantContext): string[] {
  return bucket.keys().filter((key) => key.startsWith('contacts/') || key.startsWith('calendar/'));
}
