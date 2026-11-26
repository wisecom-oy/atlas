/**
 * Reads the photo of a contact that Exchange lists as carrying an attachment, and decides what a
 * "not found" answer to that request means.
 *
 * A `404` there has two causes the answer alone does not tell apart. A contact whose only attachment
 * is not a photo answers it on every run, and a contact with a photo can answer it during an
 * incident, which `with_graph_retry` never retries. Taking the answer at its word stored the contact
 * without its photo, advanced the folder's delta link and never asked again (issue #854).
 *
 * The answer is therefore recorded as a streak on the contact's entry and the photo is requested
 * again on later runs, without holding the folder's link back. The contact keeps the photo its
 * previous entry had until the streak confirms there is none, by the rule a drive file's re-read
 * follows: 3 runs in a row spanning at least 24 hours. From then on the contact costs no photo
 * request until delta lists it again.
 */

import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
import {
  describe_not_found_streak,
  extend_not_found_streak,
  is_not_found_confirmed,
} from '@wisecom/atlas-core/services/shared/not-found-streak';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type {
  ContactManifestEntry,
  ContactsConnector,
  NotFoundStreak,
  TenantContext,
} from '@wisecom/atlas-types';
import { put_content_if_absent } from '@/services/shared/content-objects';
import { contacts_photo_key } from '@/services/shared/storage-keys';

/** Where a mailbox's contact photos are read from and stored to. */
export interface PhotoCaptureScope {
  readonly ctx: TenantContext;
  readonly connector: ContactsConnector;
  readonly tenant_id: string;
  readonly mailbox_id: string;
}

/** A contact's entry with its photo settled, and how many objects the photo added to storage. */
export interface PhotoCapture {
  readonly entry: ContactManifestEntry;
  readonly objects_stored: number;
}

/**
 * Requests a contact's photo and settles `entry` on the answer. `previous` is the contact's entry in
 * the previous snapshot: a "not found" answer extends its streak and keeps its photo while the
 * absence is unconfirmed.
 */
export async function capture_contact_photo(
  scope: PhotoCaptureScope,
  entry: ContactManifestEntry,
  previous: ContactManifestEntry | undefined,
  now: Date = new Date(),
): Promise<PhotoCapture> {
  const photo = await scope.connector.fetch_contact_photo(
    scope.tenant_id,
    scope.mailbox_id,
    entry.folder_id,
    entry.contact_id,
  );
  if (photo === undefined) {
    return { entry: settle_photo_not_found(entry, previous, now), objects_stored: 0 };
  }
  return store_contact_photo(scope, entry, photo);
}

/** True while a contact's photo answered "not found" but the streak has not confirmed it absent. */
export function is_photo_pending(entry: ContactManifestEntry, now: Date): boolean {
  return entry.photo_not_found !== undefined && !is_not_found_confirmed(entry.photo_not_found, now);
}

async function store_contact_photo(
  scope: PhotoCaptureScope,
  entry: ContactManifestEntry,
  photo: Uint8Array,
): Promise<PhotoCapture> {
  const photo_data = Buffer.from(photo);
  const digests = compute_content_digests(scope.ctx, photo_data);
  const photo_storage_key = contacts_photo_key(scope.mailbox_id, digests.content_name);
  const written = await put_content_if_absent(scope.ctx, photo_storage_key, photo_data);
  return {
    entry: {
      ...without_photo(entry),
      photo_storage_key,
      photo_checksum: digests.checksum,
      photo_size_bytes: photo_data.length,
    },
    objects_stored: written ? 1 : 0,
  };
}

/**
 * The entry after a "not found" photo answer: the streak extended, and the previous photo kept
 * until the streak confirms the contact has none.
 */
function settle_photo_not_found(
  entry: ContactManifestEntry,
  previous: ContactManifestEntry | undefined,
  now: Date,
): ContactManifestEntry {
  const streak = extend_not_found_streak(carried_streak(entry, previous), now);
  const settled = { ...without_photo(entry), photo_not_found: streak };
  if (is_not_found_confirmed(streak, now)) {
    logger.debug(`${describe_entry(entry)} has no photo (${streak.reads} "not found" answers)`);
    return settled;
  }
  logger.warn(
    `Photo of ${describe_entry(entry)} answered "not found"; requesting it again next run ` +
      `(${describe_not_found_streak(streak, 'absent')})`,
  );
  return { ...settled, ...photo_fields(previous) };
}

/**
 * The streak this answer builds on. A contact whose content changed since the previous entry may
 * have gained a photo, so its streak starts again.
 */
function carried_streak(
  entry: ContactManifestEntry,
  previous: ContactManifestEntry | undefined,
): NotFoundStreak | undefined {
  return previous?.checksum === entry.checksum ? previous.photo_not_found : undefined;
}

function photo_fields(previous: ContactManifestEntry | undefined): Partial<ContactManifestEntry> {
  if (previous?.photo_storage_key === undefined) return {};
  return {
    photo_storage_key: previous.photo_storage_key,
    photo_checksum: previous.photo_checksum,
    photo_size_bytes: previous.photo_size_bytes,
  };
}

function without_photo(entry: ContactManifestEntry): ContactManifestEntry {
  const {
    photo_storage_key: _key,
    photo_checksum: _checksum,
    photo_size_bytes: _size,
    photo_not_found: _streak,
    ...rest
  } = entry;
  return rest;
}

function describe_entry(entry: ContactManifestEntry): string {
  const name = entry.display_name;
  return name !== undefined && name !== ''
    ? `contact ${name} (${entry.contact_id})`
    : `contact ${entry.contact_id}`;
}
