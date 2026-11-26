import 'reflect-metadata';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactManifestEntry } from '@wisecom/atlas-types';
import {
  contact,
  type FakeConnector,
  fake_connector,
  folder,
} from '@wisecom/atlas-types/testing/stub-contacts-ports';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';

import {
  type FolderSyncDeps,
  type FolderSyncResult,
  sync_folder,
} from '@/services/backup/backup-folder-sync';

// Issue #854: a 404 on the photo of a contact Exchange lists as carrying an attachment was read as
// "no photo". The contact was stored without it, the folder's delta link advanced, and no later run
// asked again. A contact whose only attachment is not a photo answers the same 404 on every run, so
// the answer is now a streak: the photo is requested again on later runs until the answer repeats
// on 3 runs spanning 24 hours, and the folder's link is never held back for it.

const HOUR_MS = 60 * 60 * 1000;
const START = new Date('2026-11-01T00:00:00.000Z');
const PHOTO = new Uint8Array([0xff, 0xd8, 0xff]);
const F1 = folder('f1', 'Contacts');

/** Answers each photo request from `photos`, a 404 (`undefined`) for any contact not in it. */
function answer_photos(fake: FakeConnector, photos: Map<string, Uint8Array>): string[] {
  const requested: string[] = [];
  fake.connector.fetch_contact_photo = async (_tenant, _mailbox, _folder, contact_id) => {
    requested.push(contact_id);
    return photos.get(contact_id);
  };
  return requested;
}

function deps_with(fake: FakeConnector): FolderSyncDeps {
  return {
    ctx: stub_tenant_context().ctx,
    connector: fake.connector,
    tenant_id: 'tenant-1',
    mailbox_id: 'mailbox-1',
    should_interrupt: () => false,
  };
}

/** Scripts the next delta of `f1`: the contacts it lists and the link it ends on. */
function script_delta(fake: FakeConnector, upserted: string[], link: string): void {
  fake.script.deltas['f1'] = {
    upserted: upserted.map((id) => contact(id)),
    removed_ids: [],
    delta_link: link,
    reset: false,
  };
}

function completed(result: FolderSyncResult): Extract<FolderSyncResult, { complete: true }> {
  if (!result.complete) throw new Error('folder sync did not complete');
  return result;
}

function entry_of(result: FolderSyncResult, contact_id: string): ContactManifestEntry {
  const found = completed(result).entries.find((e) => e.contact_id === contact_id);
  if (found === undefined) throw new Error(`no entry for ${contact_id}`);
  return found;
}

describe('a 404 on the photo of a contact with an attachment (issue #854)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('requests the photo again on the next run and captures it there', async () => {
    const fake = fake_connector();
    const photos = new Map<string, Uint8Array>();
    const requested = answer_photos(fake, photos);
    script_delta(fake, ['c1'], 'l1');

    const first = completed(await sync_folder(deps_with(fake), F1, [], undefined));

    expect(requested).toEqual(['c1']);
    expect(first.errors).toEqual([]);
    expect(first.delta_link).toBe('l1');
    expect(entry_of(first, 'c1').photo_not_found).toEqual({ reads: 1, since: START.toISOString() });

    // The contact is unchanged, so delta does not list it again; the photo is now readable.
    photos.set('c1', PHOTO);
    script_delta(fake, [], 'l2');
    vi.setSystemTime(new Date(START.getTime() + HOUR_MS));
    const second = completed(await sync_folder(deps_with(fake), F1, first.entries, 'l1'));

    expect(requested).toEqual(['c1', 'c1']);
    expect(second.errors).toEqual([]);
    expect(second.delta_link).toBe('l2');
    const captured = entry_of(second, 'c1');
    expect(captured.photo_size_bytes).toBe(PHOTO.length);
    expect(captured.photo_storage_key).toBeDefined();
    expect(captured.photo_not_found).toBeUndefined();
  });

  it('keeps the previous photo while the 404 is unconfirmed', async () => {
    const fake = fake_connector();
    const photos = new Map([['c1', PHOTO]]);
    answer_photos(fake, photos);
    script_delta(fake, ['c1'], 'l1');
    const first = completed(await sync_folder(deps_with(fake), F1, [], undefined));
    const with_photo = entry_of(first, 'c1');

    photos.delete('c1');
    script_delta(fake, ['c1'], 'l2');
    const second = completed(await sync_folder(deps_with(fake), F1, first.entries, 'l1'));

    const kept = entry_of(second, 'c1');
    expect(kept.photo_storage_key).toBe(with_photo.photo_storage_key);
    expect(kept.photo_checksum).toBe(with_photo.photo_checksum);
    expect(kept.photo_not_found?.reads).toBe(1);
    expect(second.delta_link).toBe('l2');
  });

  it('backs up a contact whose attachment is not a photo without errors or a held link', async () => {
    const fake = fake_connector();
    const requested = answer_photos(fake, new Map());
    script_delta(fake, ['c1'], 'l0');
    let result = completed(await sync_folder(deps_with(fake), F1, [], undefined));
    expect(result.delta_link).toBe('l0');

    // Three more hourly runs, then one a day later: every run is clean and advances the link.
    const offsets = [1, 2, 3, 25].map((hours) => hours * HOUR_MS);
    for (const [run, offset] of offsets.entries()) {
      vi.setSystemTime(new Date(START.getTime() + offset));
      script_delta(fake, [], `l${run + 1}`);
      result = completed(await sync_folder(deps_with(fake), F1, result.entries, `l${run}`));
      expect(result.errors).toEqual([]);
      expect(result.delta_link).toBe(`l${run + 1}`);
    }
    expect(requested).toHaveLength(5);
    expect(entry_of(result, 'c1').photo_storage_key).toBeUndefined();
    expect(entry_of(result, 'c1').photo_not_found).toMatchObject({ reads: 5, confirmed: true });

    // Confirmed absent: later runs ask Graph nothing about the unchanged contact.
    vi.setSystemTime(new Date(START.getTime() + 26 * HOUR_MS));
    script_delta(fake, [], 'l9');
    result = completed(await sync_folder(deps_with(fake), F1, result.entries, 'l5'));
    expect(requested).toHaveLength(5);
    expect(result.delta_link).toBe('l9');
  });

  it('drops the previous photo once the absence is confirmed', async () => {
    const fake = fake_connector();
    answer_photos(fake, new Map());
    script_delta(fake, ['c1'], 'l1');
    const first = completed(await sync_folder(deps_with(fake), F1, [], undefined));
    const previous: ContactManifestEntry = {
      ...entry_of(first, 'c1'),
      photo_storage_key: 'photo-key',
      photo_checksum: 'photo-sum',
      photo_size_bytes: 3,
      photo_not_found: { reads: 2, since: START.toISOString() },
    };

    vi.setSystemTime(new Date(START.getTime() + 24 * HOUR_MS));
    script_delta(fake, [], 'l3');
    const result = completed(await sync_folder(deps_with(fake), F1, [previous], 'l1'));

    const settled = entry_of(result, 'c1');
    expect(settled.photo_storage_key).toBeUndefined();
    expect(settled.photo_not_found).toMatchObject({ reads: 3, confirmed: true });
  });

  it('confirms nothing from time passing without a new answer', async () => {
    const fake = fake_connector();
    const photos = new Map<string, Uint8Array>();
    const requested = answer_photos(fake, photos);
    const pending: ContactManifestEntry = {
      contact_id: 'c1',
      folder_id: 'f1',
      storage_key: 'k-c1',
      checksum: 'sum-c1',
      size_bytes: 1,
      photo_not_found: { reads: 3, since: START.toISOString() },
    };

    // Three answers within an hour, then the next run two days later finds the photo.
    photos.set('c1', PHOTO);
    vi.setSystemTime(new Date(START.getTime() + 48 * HOUR_MS));
    script_delta(fake, [], 'l2');
    const result = completed(await sync_folder(deps_with(fake), F1, [pending], 'l1'));

    expect(requested).toEqual(['c1']);
    expect(entry_of(result, 'c1').photo_size_bytes).toBe(PHOTO.length);
  });

  it('starts the streak again when the contact changed', async () => {
    const fake = fake_connector();
    answer_photos(fake, new Map());
    const previous: ContactManifestEntry = {
      contact_id: 'c1',
      folder_id: 'f1',
      storage_key: 'k-old',
      checksum: 'checksum-of-an-older-version',
      size_bytes: 1,
      photo_not_found: { reads: 5, since: '2026-10-01T00:00:00.000Z' },
    };
    script_delta(fake, ['c1'], 'l2');

    const result = completed(await sync_folder(deps_with(fake), F1, [previous], 'l1'));

    expect(entry_of(result, 'c1').photo_not_found).toEqual({
      reads: 1,
      since: START.toISOString(),
    });
  });
});
