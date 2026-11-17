import type { GraphContactPayload } from '@wisecom/atlas-types';

import { collision_key } from '@/services/restore/collision-key';
import { source_tag_of } from '@/services/shared/source-tag';

/** What a target folder already holds, in the terms restore uses to skip an entry. */
export interface TargetFolderContacts {
  /**
   * Source contact ids already present: contacts an earlier restore tagged, contacts this run
   * created, and original contacts still in the folder under the id the backup recorded.
   */
  readonly source_ids: Set<string>;
  /**
   * Content keys of contacts Atlas did not tag and the snapshot does not hold, such as the same
   * person entered by hand or imported by another tool.
   */
  readonly content_keys: ReadonlySet<string>;
}

/**
 * Indexes a target folder's contacts. Every contact contributes its own id, and a tagged one its
 * source id. Only a contact that is neither tagged nor itself in the snapshot contributes a
 * content key: an original the snapshot holds is matched by id, so it can never stand in for a
 * different contact that shares its name.
 */
export function index_target_contacts(
  contacts: readonly GraphContactPayload[],
  snapshot_ids: ReadonlySet<string>,
): TargetFolderContacts {
  const source_ids = new Set<string>();
  const content_keys = new Set<string>();
  for (const contact of contacts) {
    source_ids.add(contact.id);
    const source = source_tag_of(contact);
    if (source !== undefined) source_ids.add(source);
    if (source !== undefined || snapshot_ids.has(contact.id)) continue;
    const key = collision_key(contact);
    if (key !== undefined) content_keys.add(key);
  }
  return { source_ids, content_keys };
}

/**
 * Whether a manifest entry is already in the target folder: its source id is present, or it
 * matches the content of a contact Atlas did not create. A contact with no name, email, phone
 * or company is matched by source id only.
 */
export function is_already_present(
  existing: TargetFolderContacts,
  source_contact_id: string,
  contact: Readonly<Record<string, unknown>>,
): boolean {
  if (existing.source_ids.has(source_contact_id)) return true;
  const key = collision_key(contact);
  return key !== undefined && existing.content_keys.has(key);
}
