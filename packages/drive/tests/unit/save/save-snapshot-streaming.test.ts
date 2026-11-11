/**
 * Issue #617. A file above the stream threshold was decrypted into one buffer before it reached
 * the archive, so a save cost about twice the largest file in memory. It is now streamed into the
 * archive entry, verified first so a bad object is still a per-file skip and never a written entry.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveEntryAbortedError } from '@wisecom/atlas-core/services/shared/archive-stream-entry';
import { read_zip_entries } from '@wisecom/atlas-types/testing/zip-entry-reader';
import type { TenantContext, TenantContextFactory } from '@wisecom/atlas-types';
import { stub_encrypted_object_store } from '@wisecom/atlas-types/testing/stub-encrypted-object-store';
import type { DriveManifestEntry } from '@/drive-ports';
import type { DriveChainManifest } from '@/shared/manifest-chain';
import { save_drive_snapshot, type DriveSaveDeps } from '@/save/save-snapshot';
import {
  readable_indexes,
  readable_manifests,
} from '@wisecom/atlas-types/testing/readable-listing';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const CHUNK_BYTES = 64 * 1024;
/** Above the 4 MiB stream threshold. */
const LARGE_BYTES = 5 * 1024 * 1024;

/** One stored file: its plaintext and the manifest entry that points at it. */
interface StoredFile {
  readonly plaintext: Buffer;
  readonly entry: DriveManifestEntry;
}

/** A save harness over an in-memory encrypted store that records every streamed read. */
interface SaveHarness {
  readonly deps: DriveSaveDeps<DriveChainManifest>;
  /** Adds a file with a correct manifest checksum, returning it. */
  add(file_id: string, size: number): StoredFile;
  /** Replaces the stored ciphertext of a file. */
  set_stored(file_id: string, stored: Buffer): void;
  /** Encrypts plaintext with the harness key, as the store would. */
  encrypt(plaintext: Buffer): Buffer;
  /** Ciphertext served from the nth (0-based) streamed read of a file, when it should differ. */
  override_read(file_id: string, read_index: number, stored: Buffer): void;
  /** For each streamed read so far: the file, chunks served, and chunks the object holds. */
  readonly reads: Array<{ file_id: string; pulled: number; total: number }>;
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** Builds a harness whose snapshot holds whatever files `add` registers. */
function make_save_harness(): SaveHarness {
  const store = stub_encrypted_object_store();
  const stored = new Map<string, Buffer>();
  const overrides = new Map<string, Buffer>();
  const entries: DriveManifestEntry[] = [];
  const reads: SaveHarness['reads'] = [];
  const key_of = (file_id: string): string => `onedrive/data/owner-1/${file_id}`;
  const id_of = (key: string): string => key.slice(key.lastIndexOf('/') + 1);

  const ctx = {
    tenant_id: 'tenant-test',
    storage: {
      get: async (key: string) => Buffer.from(stored.get(key)!),
      get_stream: async (key: string) => {
        const file_id = id_of(key);
        const read_index = reads.filter((read) => read.file_id === file_id).length;
        const body = overrides.get(`${file_id}#${read_index}`) ?? stored.get(key)!;
        return counted_stream(body, file_id, reads);
      },
    },
    decrypt: (payload: Buffer) => store.decrypt(payload),
    create_decipher: (iv: Buffer, auth_tag: Buffer) => store.create_decipher(iv, auth_tag),
    destroy: () => undefined,
  } as unknown as TenantContext;

  const manifest: DriveChainManifest = {
    snapshot_id: 'snap-1',
    created_at: new Date('2026-03-01T00:00:00Z'),
    entries,
  };
  const deps: DriveSaveDeps<DriveChainManifest> = {
    workload: 'onedrive',
    tenant_factory: { create_readonly: async () => ctx } as unknown as TenantContextFactory,
    manifests: {
      workload: 'OneDrive',
      find_by_snapshot: async () => manifest,
      list_readable_snapshots: async () => readable_manifests([manifest]),
    },
  };

  return {
    deps,
    reads,
    encrypt: (plaintext) => store.encrypt(plaintext),
    add(file_id, size) {
      const plaintext = randomBytes(size);
      stored.set(key_of(file_id), store.encrypt(plaintext));
      const entry = build_entry(file_id, key_of(file_id), size, sha256(plaintext));
      entries.push(entry);
      return { plaintext, entry };
    },
    set_stored: (file_id, body) => stored.set(key_of(file_id), body),
    override_read: (file_id, read_index, body) => overrides.set(`${file_id}#${read_index}`, body),
  };
}

function build_entry(
  file_id: string,
  storage_key: string,
  size_bytes: number,
  checksum: string,
): DriveManifestEntry {
  return {
    file_id,
    drive_id: 'drive-1',
    file_name: `${file_id}.bin`,
    parent_path: '/Documents',
    size_bytes,
    storage_key,
    checksum,
    backup_at: '2026-03-01T00:00:00.000Z',
    change_type: 'created',
  } as DriveManifestEntry;
}

/** Serves `body` in fixed chunks, recording how many have been pulled. */
function counted_stream(body: Buffer, file_id: string, reads: SaveHarness['reads']): Readable {
  const total = Math.ceil(body.length / CHUNK_BYTES);
  const read = { file_id, pulled: 0, total };
  reads.push(read);
  async function* chunks(): AsyncGenerator<Buffer> {
    for (let offset = 0; offset < body.length; offset += CHUNK_BYTES) {
      read.pulled++;
      yield body.subarray(offset, offset + CHUNK_BYTES);
    }
  }
  return Readable.from(chunks());
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-drive-save-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function collect(stream: PassThrough): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => resolve(Buffer.concat(chunks)));
  stream.on('error', reject);
  return promise;
}

async function save_to_stream(harness: ReturnType<typeof make_save_harness>) {
  const output = new PassThrough();
  const received = collect(output);
  const result = await save_drive_snapshot(harness.deps, 'tenant-test', 'owner-1', {
    snapshot_id: 'snap-1',
    output,
  });
  return { result, entries: read_zip_entries(await received) };
}

describe('save_drive_snapshot with a file above the stream threshold', () => {
  it('writes the large file and a small one byte for byte', async () => {
    const harness = make_save_harness();
    const large = harness.add('large', LARGE_BYTES);
    const small = harness.add('small', 2048);

    const { result, entries } = await save_to_stream(harness);

    expect(result.files_saved).toBe(2);
    expect(result.errors).toEqual([]);
    expect(entries.get('Documents/large.bin')!.equals(large.plaintext)).toBe(true);
    expect(entries.get('Documents/small.bin')!.equals(small.plaintext)).toBe(true);
  });

  it('streams the plaintext into the archive instead of reading it whole first', async () => {
    const harness = make_save_harness();
    harness.add('large', LARGE_BYTES);
    const stalled = new Writable({ highWaterMark: 64 * 1024, write: () => undefined });

    const pending = save_drive_snapshot(harness.deps, 'tenant-test', 'owner-1', {
      snapshot_id: 'snap-1',
      output: stalled,
    });
    pending.catch(() => undefined);
    await delay(300);

    // The read feeding the archive stops where the stalled destination stops taking bytes.
    // Buffering the whole file drained that read completely before anything was written.
    const feeding = harness.reads.at(-1)!;
    expect(feeding.pulled).toBeLessThan(feeding.total / 2);
    stalled.destroy();
    await expect(pending).rejects.toThrow();
  });

  it('skips a large file whose checksum does not match, leaving no entry for it', async () => {
    const harness = make_save_harness();
    const large = harness.add('large', LARGE_BYTES);
    harness.add('small', 2048);
    harness.set_stored('large', harness.encrypt(Buffer.alloc(LARGE_BYTES, 1)));

    const { result, entries } = await save_to_stream(harness);

    expect(result.files_saved).toBe(1);
    expect(result.integrity_failures).toEqual([large.entry.file_id]);
    expect([...entries.keys()]).toEqual(['Documents/small.bin']);
  });

  it('reports a large file that fails GCM authentication and keeps saving the rest', async () => {
    const harness = make_save_harness();
    const large = harness.add('large', LARGE_BYTES);
    harness.add('small', 2048);
    const tampered = harness.encrypt(large.plaintext);
    tampered[tampered.length - 100] ^= 0xff;
    harness.set_stored('large', tampered);

    const { result, entries } = await save_to_stream(harness);

    expect(result.files_saved).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^large\.bin: /);
    expect(result.integrity_failures).toEqual([large.entry.file_id]);
    expect([...entries.keys()]).toEqual(['Documents/small.bin']);
  });

  it('abandons the archive when the object changes between the check and the write', async () => {
    const harness = make_save_harness();
    harness.add('large', LARGE_BYTES);
    harness.override_read('large', 1, harness.encrypt(Buffer.alloc(LARGE_BYTES, 2)));
    const output_path = join(dir, 'export.zip');

    const pending = save_drive_snapshot(harness.deps, 'tenant-test', 'owner-1', {
      snapshot_id: 'snap-1',
      output_path,
    });

    await expect(pending).rejects.toBeInstanceOf(ArchiveEntryAbortedError);
    await expect(pending).rejects.toThrow(/Checksum mismatch for large\.bin/);
    expect(existsSync(output_path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});
