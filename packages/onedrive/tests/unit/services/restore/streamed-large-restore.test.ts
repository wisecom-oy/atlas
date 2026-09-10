import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoredBlobRef, TenantContext } from '@wisecom/atlas-types';
import { stub_encrypted_object_store } from '@wisecom/atlas-types/testing/stub-encrypted-object-store';
import {
  LARGE_UPLOAD_CHUNK,
  upload_content_to_session,
} from '@wisecom/atlas-drive/restore/upload-session';
import { download_and_decrypt_blob } from '@/services/restore/blob-restore';
import { OneDriveDecryptAuthError } from '@/services/restore/restore-integrity';

/**
 * Issue #343: restore decrypted the whole object into memory before the first byte went to Graph,
 * so a 1 GiB file peaked near 2 GiB. The plaintext now flows into the upload session as it is
 * decrypted, which means the session must not be allowed to create the item until the source has
 * ended and the checksum has matched.
 */

const UPLOAD_URL = 'https://graph.test/upload/session-1';
const OBJECT_BYTES = 48 * 1024 * 1024;
const SOURCE_CHUNK = 4 * 1024 * 1024;

/** Digest of what a party ended up with, which is how the two sides are compared. */
function sha256_hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

interface Harness {
  readonly ctx: TenantContext;
  readonly ref: StoredBlobRef;
  readonly plaintext: Buffer;
  /** Ciphertext bytes the storage stream has produced so far. */
  read_bytes: () => number;
}

/** A stored object served in fixed-size pieces, with the read position observable. */
function stored_object(options: { corrupt?: boolean; wrong_checksum?: boolean } = {}): Harness {
  const store = stub_encrypted_object_store();
  const plaintext = randomBytes(OBJECT_BYTES);
  const stored = store.encrypt(plaintext);
  if (options.corrupt === true) stored[stored.length - 1] ^= 0xff;
  let read_bytes = 0;

  const ctx = {
    storage: {
      get_stream: async (): Promise<Readable> => {
        let offset = 0;
        return new Readable({
          highWaterMark: SOURCE_CHUNK,
          read() {
            if (offset >= stored.length) {
              this.push(null);
              return;
            }
            const end = Math.min(offset + SOURCE_CHUNK, stored.length);
            const piece = stored.subarray(offset, end);
            offset = end;
            read_bytes = end;
            this.push(piece);
          },
        });
      },
    },
    create_decipher: store.create_decipher,
  } as unknown as TenantContext;

  const checksum =
    options.wrong_checksum === true
      ? sha256_hex(Buffer.from('a different file'))
      : sha256_hex(plaintext);

  return {
    ctx,
    plaintext,
    read_bytes: () => read_bytes,
    ref: {
      file_id: 'item-1',
      file_name: 'Report.bin',
      storage_key: 'onedrive/data/ab/cd/object',
      checksum,
      size_bytes: OBJECT_BYTES,
    } as StoredBlobRef,
  };
}

/**
 * A Graph upload session that records what it was sent.
 *
 * Completion follows the contract rather than the object: the session commits as soon as a
 * `Content-Range` reaches the total it was opened for, which is what makes a declared total that
 * understates the source dangerous.
 */
function stub_session(harness: Harness): {
  uploaded: Buffer[];
  ranges: string[];
  deletes: () => number;
  peak_in_flight: () => number;
} {
  const uploaded: Buffer[] = [];
  const ranges: string[] = [];
  let deletes = 0;
  let peak_in_flight = 0;
  let sent = 0;

  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (
        _url: string,
        init?: { method?: string; headers?: Record<string, string>; body?: Buffer },
      ) => {
        const method = init?.method ?? 'GET';
        if (method === 'DELETE') {
          deletes++;
          return new Response('', { status: 204 });
        }
        if (method !== 'PUT') return new Response('{"nextExpectedRanges":["0-"]}', { status: 200 });

        const body = init!.body!;
        const range = init!.headers!['Content-Range']!;
        uploaded.push(Buffer.from(body));
        ranges.push(range);
        // Bytes decrypted but not yet handed to Graph: this is what restore has to hold.
        peak_in_flight = Math.max(peak_in_flight, harness.read_bytes() - sent);
        sent += body.length;

        const [, last, total] = /bytes \d+-(\d+)\/(\d+)/.exec(range)!;
        const committed = Number(last) === Number(total) - 1;
        return new Response(committed ? '{"id":"item-1"}' : '{}', {
          status: committed ? 201 : 202,
        });
      },
    ),
  );

  return { uploaded, ranges, deletes: () => deletes, peak_in_flight: () => peak_in_flight };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('streamed large restore (issue #343)', () => {
  it('uploads the object without ever holding it whole', async () => {
    const harness = stored_object();
    const session = stub_session(harness);

    const content = await download_and_decrypt_blob(harness.ctx, harness.ref);
    expect(Buffer.isBuffer(content)).toBe(false);

    await upload_content_to_session(UPLOAD_URL, content!, harness.ref.file_name);

    // Digests, not a deep buffer comparison: 48 MiB of element-by-element equality is minutes.
    expect(sha256_hex(Buffer.concat(session.uploaded))).toBe(sha256_hex(harness.plaintext));
    // Bounded by the chunk sizes in play, not by the size of the object.
    expect(session.peak_in_flight()).toBeLessThanOrEqual(2 * LARGE_UPLOAD_CHUNK + SOURCE_CHUNK);
    // The committing PUT is the one that carries the last byte, and it only goes out after the
    // decrypt stream has ended.
    expect(session.ranges.at(-1)).toMatch(new RegExp(`-${OBJECT_BYTES - 1}/${OBJECT_BYTES}$`));
    expect(session.deletes()).toBe(0);
  });

  it('never creates the item when the checksum does not match the manifest', async () => {
    const harness = stored_object({ wrong_checksum: true });
    const session = stub_session(harness);

    const content = await download_and_decrypt_blob(harness.ctx, harness.ref);

    await expect(
      upload_content_to_session(UPLOAD_URL, content!, harness.ref.file_name),
    ).rejects.toThrow(/Checksum mismatch/);

    // Everything Graph received is still uncommitted, and the session is gone.
    expect(Buffer.concat(session.uploaded).length).toBeLessThan(OBJECT_BYTES);
    expect(session.deletes()).toBe(1);
  });

  it('reports a failed authentication tag as an auth error and abandons the session', async () => {
    const harness = stored_object({ corrupt: true });
    const session = stub_session(harness);

    const content = await download_and_decrypt_blob(harness.ctx, harness.ref);

    await expect(
      upload_content_to_session(UPLOAD_URL, content!, harness.ref.file_name),
    ).rejects.toBeInstanceOf(OneDriveDecryptAuthError);
    expect(session.deletes()).toBe(1);
  });

  it('skips an entry the manifest cannot verify rather than restoring it unchecked', async () => {
    const harness = stored_object();

    const content = await download_and_decrypt_blob(harness.ctx, {
      ...harness.ref,
      checksum: undefined,
    } as StoredBlobRef);

    expect(content).toBeUndefined();
  });

  it('refuses to commit when the source is longer than the manifest recorded', async () => {
    // Graph commits as soon as the ranges cover the total the session was opened for, and that
    // total comes from the manifest. An object longer than its recorded size would otherwise fill
    // the declared range from inside the stream, committing bytes no tag and no digest had passed.
    const harness = stored_object();
    const understated = 2 * LARGE_UPLOAD_CHUNK;
    const session = stub_session(harness);

    const content = await download_and_decrypt_blob(harness.ctx, {
      ...harness.ref,
      size_bytes: understated,
    } as StoredBlobRef);

    await expect(
      upload_content_to_session(UPLOAD_URL, content!, harness.ref.file_name),
    ).rejects.toThrow(/more content than the \d+ byte\(s\) recorded for it/);

    expect(
      session.ranges.some((range) => range.endsWith(`-${understated - 1}/${understated}`)),
    ).toBe(false);
    expect(session.deletes()).toBe(1);
  });
});
