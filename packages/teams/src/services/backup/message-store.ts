import type {
  TeamsGraphResource,
  TeamsKeptMessageRef,
  TeamsMessageLocator,
  TeamsMessageRef,
} from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import type { HostedOwner } from '@/services/backup/hosted-reference-scanner';
import {
  type DigestedBlob,
  digest_message_blob,
  write_blob,
} from '@/services/backup/message-blob-writer';
import { store_message_hosted } from '@/services/backup/message-hosted-store';
import { message_ref_blobs } from '@/services/shared/thread-blobs';

/** Outcome of storing one message version: its new ref, its warnings, and whether it was reused. */
export interface MessageStoreOutcome {
  readonly ref: TeamsMessageRef;
  readonly warnings: string[];
  readonly deduped: boolean;
}

/**
 * Stores one root or reply version. A live message whose blob and hosted content are unchanged
 * reuses its previous ref. A message that Graph reports deleted keeps its last live version once
 * (N9), and writes a tombstone whose blob is the message as Graph returned it.
 */
export async function store_message(
  scope: BackupRunScope,
  locator: TeamsMessageLocator,
  owner: HostedOwner,
  previous: TeamsMessageRef | undefined,
  message: TeamsGraphResource,
): Promise<MessageStoreOutcome> {
  const digest = digest_message_blob(scope, message);
  if (typeof message.deletedDateTime === 'string' && message.deletedDateTime !== '') {
    return store_tombstone(scope, previous, message, digest);
  }
  if (previous !== undefined && (await is_unchanged(scope, previous, digest.storage_key))) {
    return { ref: previous, warnings: [], deduped: true };
  }
  return store_live_version(scope, locator, owner, previous, message, digest);
}

/**
 * Turns a live message into its deleted form when Graph reported only the removal, with no body
 * this run. Its last live version is kept, as for a deleted message with a body.
 */
export function mark_message_removed(
  scope: BackupRunScope,
  previous: TeamsMessageRef,
): TeamsMessageRef {
  if (previous.deleted_at !== undefined) {
    return previous;
  }
  return {
    storage_key: previous.storage_key,
    checksum: previous.checksum,
    size_bytes: previous.size_bytes,
    last_modified_at: previous.last_modified_at,
    deleted_at: scope.backup_at,
    kept: previous.kept ?? live_version_of(previous),
    hosted: {},
  };
}

async function store_tombstone(
  scope: BackupRunScope,
  previous: TeamsMessageRef | undefined,
  message: TeamsGraphResource,
  digest: DigestedBlob,
): Promise<MessageStoreOutcome> {
  const deleted_at = String(message.deletedDateTime);
  const reusable =
    previous?.deleted_at !== undefined &&
    previous.storage_key === digest.storage_key &&
    (await scope.ctx.storage.exists(digest.storage_key));
  if (!reusable) {
    await write_blob(scope, digest.storage_key, digest.plaintext);
  }
  const ref: TeamsMessageRef = {
    storage_key: digest.storage_key,
    checksum: digest.checksum,
    size_bytes: digest.plaintext.length,
    last_modified_at:
      typeof message.lastModifiedDateTime === 'string' ? message.lastModifiedDateTime : deleted_at,
    deleted_at,
    kept: kept_for_deleted(previous),
    hosted: {},
  };
  return { ref, warnings: [], deduped: reusable };
}

/** Keeps the first live version a message had. Once set, the kept version is never replaced. */
function kept_for_deleted(previous: TeamsMessageRef | undefined): TeamsKeptMessageRef | undefined {
  if (previous === undefined) {
    return undefined;
  }
  if (previous.kept !== undefined) {
    return previous.kept;
  }
  return previous.deleted_at === undefined ? live_version_of(previous) : undefined;
}

function live_version_of(ref: TeamsMessageRef): TeamsKeptMessageRef {
  return {
    storage_key: ref.storage_key,
    checksum: ref.checksum,
    size_bytes: ref.size_bytes,
    hosted: ref.hosted,
  };
}

async function is_unchanged(
  scope: BackupRunScope,
  previous: TeamsMessageRef,
  storage_key: string,
): Promise<boolean> {
  if (
    scope.force_full ||
    previous.deleted_at !== undefined ||
    previous.storage_key !== storage_key ||
    (previous.hosted_missing?.length ?? 0) > 0
  ) {
    return false;
  }
  const checks = await Promise.all(
    message_ref_blobs(previous).map((blob) => scope.ctx.storage.exists(blob.storage_key)),
  );
  return checks.every(Boolean);
}

async function store_live_version(
  scope: BackupRunScope,
  locator: TeamsMessageLocator,
  owner: HostedOwner,
  previous: TeamsMessageRef | undefined,
  message: TeamsGraphResource,
  digest: DigestedBlob,
): Promise<MessageStoreOutcome> {
  const relist = (previous?.hosted_missing?.length ?? 0) > 0;
  const { hosted, missing } = await store_message_hosted(
    scope,
    locator,
    owner,
    message,
    previous?.hosted ?? {},
    relist,
  );
  await write_blob(scope, digest.storage_key, digest.plaintext);
  const warnings =
    missing.length === 0
      ? []
      : [`hosted content missing on message ${message.id}: ${missing.length} item(s)`];
  const ref: TeamsMessageRef = {
    storage_key: digest.storage_key,
    checksum: digest.checksum,
    size_bytes: digest.plaintext.length,
    last_modified_at:
      typeof message.lastModifiedDateTime === 'string' ? message.lastModifiedDateTime : '',
    kept: previous?.kept,
    hosted,
    hosted_missing: missing.length === 0 ? undefined : missing,
  };
  return { ref, warnings, deduped: false };
}
