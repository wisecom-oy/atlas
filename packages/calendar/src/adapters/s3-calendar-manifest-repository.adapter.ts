import { is_absent_object_error } from '@wisecom/atlas-core/services/shared/absent-object';
import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import type {
  CalendarManifestRepository,
  CalendarSnapshotManifest,
  TenantContext,
} from '@wisecom/atlas-types';
import { StorageError } from '@wisecom/atlas-types';
import { injectable } from 'inversify';
import { read_content } from '@/services/shared/content-objects';
import { calendar_manifest_key, calendar_manifest_prefix } from '@/services/shared/storage-keys';

/** Reads and validates one encrypted manifest; undefined only when the object is absent. */
async function download_manifest(
  ctx: TenantContext,
  key: string,
  mailbox_id: string,
): Promise<CalendarSnapshotManifest | undefined> {
  let plaintext: Buffer;
  try {
    plaintext = await read_content(ctx, key);
  } catch (err) {
    if (is_absent_object_error(err)) return undefined;
    throw new StorageError(`Could not read the calendar manifest at ${key}`, { cause: err });
  }
  // The manifest was written by this package, so its shape is trusted once the identity checks pass.
  const manifest = JSON.parse(plaintext.toString('utf-8')) as CalendarSnapshotManifest;
  if (normalize_owner_id(manifest.mailbox_id) !== normalize_owner_id(mailbox_id)) {
    throw new StorageError(`Calendar manifest at ${key} belongs to another mailbox`);
  }
  if (Number.isNaN(Date.parse(manifest.created_at))) {
    throw new StorageError(`Calendar manifest at ${key} has an invalid created_at`);
  }
  return manifest;
}

/** Milliseconds embedded in a `cal-snap-<ms>-<hex>` id; 0 for anything else, sorting it last. */
function snapshot_time(key: string): number {
  const match = /cal-snap-(\d+)-/.exec(key);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

/** Persists calendar snapshot manifests as encrypted JSON in S3. */
@injectable()
export class S3CalendarManifestRepository implements CalendarManifestRepository {
  /** Encrypts and stores one snapshot manifest. */
  async save(ctx: TenantContext, manifest: CalendarSnapshotManifest): Promise<void> {
    const key = calendar_manifest_key(manifest.mailbox_id, manifest.snapshot_id);
    await ctx.storage.put(key, ctx.encrypt(Buffer.from(JSON.stringify(manifest)), key));
  }

  /** Loads one snapshot's manifest, or undefined when it does not exist. */
  async find_by_snapshot(
    ctx: TenantContext,
    mailbox_id: string,
    snapshot_id: string,
  ): Promise<CalendarSnapshotManifest | undefined> {
    return download_manifest(ctx, calendar_manifest_key(mailbox_id, snapshot_id), mailbox_id);
  }

  /** Loads the newest manifest of a mailbox. Newest is taken from the snapshot id, so one download suffices. */
  async find_latest_by_mailbox(
    ctx: TenantContext,
    mailbox_id: string,
  ): Promise<CalendarSnapshotManifest | undefined> {
    const keys = await manifest_keys(ctx, mailbox_id);
    const newest = keys.reduce<string | undefined>(
      (best, key) => (best === undefined || snapshot_time(key) > snapshot_time(best) ? key : best),
      undefined,
    );
    return newest === undefined ? undefined : download_manifest(ctx, newest, mailbox_id);
  }

  /** Lists every manifest of a mailbox, newest first. */
  async list_snapshots_by_mailbox(
    ctx: TenantContext,
    mailbox_id: string,
  ): Promise<CalendarSnapshotManifest[]> {
    const keys = await manifest_keys(ctx, mailbox_id);
    const manifests: CalendarSnapshotManifest[] = [];
    for (const key of keys) {
      const manifest = await download_manifest(ctx, key, mailbox_id);
      if (manifest !== undefined) manifests.push(manifest);
    }
    return manifests.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }
}

/** Object keys of a mailbox's manifests. */
async function manifest_keys(ctx: TenantContext, mailbox_id: string): Promise<string[]> {
  const keys = await ctx.storage.list(calendar_manifest_prefix(mailbox_id));
  return keys.filter((key) => key.endsWith('.json'));
}
