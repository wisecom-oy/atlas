import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '@wisecom/atlas-types';
import {
  add_file_to_archive,
  create_file_archive,
  finalize_file_archive,
} from '@/services/shared/file-save-zip-writer';
import {
  resolve_save_target,
  settle_empty_save_target,
} from '@/services/shared/save-archive-target';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-zip-stream-'));
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
describe('create_file_archive with a stream target', () => {
  it('delivers the archive to the caller stream and writes no file (issue #44)', async () => {
    const sink = new PassThrough();
    const received = collect(sink);
    const { archive, promise, publish } = create_file_archive(sink);

    await add_file_to_archive(archive, '/Documents', 'report.txt', Buffer.from('hello'));
    await finalize_file_archive(archive);
    const total_bytes = await promise;
    await publish();
    const body = await received;

    expect(total_bytes).toBeGreaterThan(0);
    expect(body.length).toBe(total_bytes);
    expect(body.subarray(0, 4)).toEqual(ZIP_MAGIC);
    // A stream export exists so the bytes never land on the exporting machine's disk.
    expect(readdirSync(dir)).toEqual([]);
  });

  it('destroys the stream on abort, so a truncated archive is never a successful transfer', async () => {
    const sink = new PassThrough();
    const { archive, abort } = create_file_archive(sink);
    await add_file_to_archive(archive, '/', 'report.txt', Buffer.from('hello'));

    await abort();

    expect(sink.destroyed).toBe(true);
    // `end()` would have handed the consumer a valid-looking short zip instead.
    expect(sink.writableEnded).toBe(false);
  });

  it('reports a destination failure rather than a successful save', async () => {
    const sink = new PassThrough();
    const { archive, promise } = create_file_archive(sink);
    const failure = new Error('consumer went away');
    sink.destroy(failure);

    await add_file_to_archive(archive, '/', 'report.txt', Buffer.from('hello')).catch(
      () => undefined,
    );
    await expect(promise).rejects.toThrow(failure.message);
  });
});

describe('resolve_save_target', () => {
  it('refuses a stream and a path together instead of silently dropping one', () => {
    const sink = new PassThrough();
    expect(() =>
      resolve_save_target({ output: sink, output_path: join(dir, 'out.zip') }, () => 'default.zip'),
    ).toThrow(ConfigError);
  });

  it('reports no output path for a stream, and the resolved path otherwise', () => {
    const sink = new PassThrough();
    expect(resolve_save_target({ output: sink }, () => 'default.zip')).toEqual({
      target: sink,
      output_path: '',
    });
    expect(resolve_save_target({ output_path: 'chosen.zip' }, () => 'default.zip')).toEqual({
      target: 'chosen.zip',
      output_path: 'chosen.zip',
    });
    expect(resolve_save_target({}, () => 'default.zip')).toEqual({
      target: 'default.zip',
      output_path: 'default.zip',
    });
  });
});

describe('settle_empty_save_target', () => {
  it('hands a completed empty export a valid empty archive rather than a zero-byte body', async () => {
    const sink = new PassThrough();
    const received = collect(sink);

    await settle_empty_save_target(sink, false);
    const body = await received;

    // An archive with no entries is exactly one end-of-central-directory record, which is what
    // makes it a zip an extractor opens rather than an empty download.
    expect(body).toEqual(Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]));
    expect(sink.writableEnded).toBe(true);
  });

  it('destroys the stream for an interrupted empty export', async () => {
    const sink = new PassThrough();

    await settle_empty_save_target(sink, true);

    expect(sink.destroyed).toBe(true);
    expect(sink.writableEnded).toBe(false);
  });

  it('creates no file for a path target that produced nothing', async () => {
    await settle_empty_save_target(join(dir, 'out.zip'), false);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('create_file_archive with a path target', () => {
  it('still stages and publishes, so #307 holds for file exports', async () => {
    const output_path = join(dir, 'out.zip');
    const { archive, promise, publish } = create_file_archive(output_path);

    await add_file_to_archive(archive, '/', 'report.txt', Buffer.from('hello'));
    await finalize_file_archive(archive);
    expect(existsSync(output_path)).toBe(false);

    await promise;
    await publish();

    expect(existsSync(output_path)).toBe(true);
    expect(readdirSync(dir)).toEqual(['out.zip']);
  });
});
