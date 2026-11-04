import type { TeamsMessageRef, TeamsStoredBlobRef, TeamsThread } from '@wisecom/atlas-types';

/** The blob refs (storage key, checksum, size) of one stored object. */
function blob_ref_of(ref: TeamsStoredBlobRef): TeamsStoredBlobRef {
  return { storage_key: ref.storage_key, checksum: ref.checksum, size_bytes: ref.size_bytes };
}

/**
 * Every blob one message version references: its own blob, its hosted-content items, and, for a
 * deleted message, the last live version it kept with that version's hosted content.
 */
export function message_ref_blobs(ref: TeamsMessageRef): TeamsStoredBlobRef[] {
  const kept =
    ref.kept === undefined ? [] : [blob_ref_of(ref.kept), ...Object.values(ref.kept.hosted)];
  return [blob_ref_of(ref), ...Object.values(ref.hosted), ...kept].map(blob_ref_of);
}

/**
 * Every blob a thread references: the root, each reply, and their hosted and kept blobs.
 * Verification and size totals both read blobs through this list.
 */
export function message_thread_blobs(thread: TeamsThread): TeamsStoredBlobRef[] {
  return [thread.root, ...Object.values(thread.replies)].flatMap(message_ref_blobs);
}
