/**
 * Architecture guard: an encrypted JSON metadata object (manifest, index, cursor, pointer,
 * checkpoint) is written through `write_encrypted_json`, never with a raw `storage.put(`. The
 * guarded writer checks the object the way its reader will, proves the ciphertext decrypts, and
 * applies the create-only and read-back rules; a raw PUT skips all of it and the damage is only
 * found on a later read.
 *
 * It lives in the SDK package next to the CLI/SDK parity guard: the SDK depends on every package
 * that writes to storage, so a change in any of them re-runs this test.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const PACKAGES_DIR = join(REPO_ROOT, 'packages');
const RAW_PUT = /storage\s*\.put\(/;

/** The only files that may call `storage.put(` directly, each with the reason it is not JSON metadata. */
const RAW_PUT_ALLOWLIST: Record<string, string> = {
  // The guarded writer itself: the one place a metadata object reaches storage.
  'core/src/services/shared/stored-object-put.ts': 'the guarded writer',
  // Content blobs: opaque bytes with no reader shape to check, verified by checksum on read.
  'calendar/src/services/shared/content-objects.ts': 'event and attachment content',
  'contacts/src/services/shared/content-objects.ts': 'contact and photo content',
  'drive/src/backup/file-processor.ts': 'file content',
  'drive/src/versioning/version-content-store.ts': 'file version content',
  'outlook/src/services/backup/attachment-storage-sync.ts': 'attachment content',
  'outlook/src/services/backup/message-payload-store.ts': 'message body content',
  'teams/src/services/backup/message-blob-writer.ts': 'Teams message and hosted content',
  // The wrapped data key: binary, with its own create-only and compare-and-swap protocol.
  's3/src/adapters/tenant-context.factory.ts': 'data key bootstrap, create-only',
  'core/src/services/keys/dek-rewrap.service.ts': 'data key rewrap, compare-and-swap',
  'core/src/services/replication/conditional-dek-write.ts': 'data key copy to a replica',
  // The replica marker: a plaintext create-only marker, not an encrypted object.
  'core/src/services/replication/replica-target-bootstrap.ts': 'replica marker',
  // Replication copies a manifest's ciphertext unchanged; re-encrypting would change the bytes.
  'core/src/services/replication/snapshot-replicator.ts': 'byte-identical manifest copy',
  'core/src/services/replication/snapshot-objects-replicator.ts': 'byte-identical manifest copy',
  // The registry retries on its own ETag compare-and-swap, which the guarded writer does not model.
  's3/src/adapters/s3-identity-registry-repository.adapter.ts': 'identity registry CAS loop',
  // The owner lease is plain JSON by design, so it can be taken without the tenant key. It is
  // only ever written under a condition and read back for its holder id.
  'core/src/services/lease/owner-lease-record.ts':
    'owner lease, unencrypted, create-only and compare-and-swap',
  // A throwaway plaintext object `storage-check` writes to see the conditions refused, then removes.
  's3/src/adapters/s3-conditional-write-probe.ts': 'storage-check conditional-write probe',
};

/** Every `.ts` file under `packages/<name>/src`, as a path relative to `packages/`. */
function source_files(): string[] {
  const files: string[] = [];
  for (const name of readdirSync(PACKAGES_DIR)) {
    const src = join(PACKAGES_DIR, name, 'src');
    if (statSync(src, { throwIfNoEntry: false })?.isDirectory()) collect_ts_files(src, files);
  }
  return files.map((file) => relative(PACKAGES_DIR, file).split('\\').join('/'));
}

function collect_ts_files(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect_ts_files(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
}

function calls_raw_put(file: string): boolean {
  return RAW_PUT.test(readFileSync(join(PACKAGES_DIR, file), 'utf8'));
}

describe('metadata write guard', () => {
  const raw_put_files = source_files().filter(calls_raw_put).sort();

  it('finds the source tree it scans', () => {
    expect(raw_put_files).toContain('core/src/services/shared/stored-object-put.ts');
  });

  it('lets no file outside the allowlist call storage.put( directly', () => {
    const offenders = raw_put_files.filter((file) => !(file in RAW_PUT_ALLOWLIST));

    expect(
      offenders,
      `These files call storage.put( directly:\n  ${offenders.join('\n  ')}\n` +
        'Write an encrypted JSON metadata object with write_encrypted_json from ' +
        '@wisecom/atlas-core/services/shared/stored-json-writer, which validates, verifies and ' +
        'confirms the write. Only content blobs and key material belong in RAW_PUT_ALLOWLIST ' +
        'in packages/sdk/tests/unit/metadata-write-guard.test.ts, each with its reason.',
    ).toEqual([]);
  });

  it('keeps the allowlist exact: every entry still calls storage.put(', () => {
    const stale = Object.keys(RAW_PUT_ALLOWLIST).filter((file) => !raw_put_files.includes(file));

    expect(stale, 'Remove allowlist entries that no longer write raw objects').toEqual([]);
  });
});
