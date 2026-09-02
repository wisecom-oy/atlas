import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  add_file_to_archive,
  create_file_archive,
  finalize_file_archive,
} from '@/services/shared/file-save-zip-writer';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-zip-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('create_file_archive', () => {
  it('writes an archive and reports the byte count', async () => {
    const output_path = join(dir, 'out.zip');
    const { archive, promise, publish } = create_file_archive(output_path);

    await add_file_to_archive(archive, '/Documents', 'report.txt', Buffer.from('hello'));
    await finalize_file_archive(archive);
    const total_bytes = await promise;
    await publish();

    expect(total_bytes).toBeGreaterThan(0);
    expect(existsSync(output_path)).toBe(true);
  });

  it('writes nothing to the output path before it is published (issue #307)', async () => {
    const output_path = join(dir, 'out.zip');
    const { archive } = create_file_archive(output_path);

    await add_file_to_archive(archive, '/', 'report.txt', Buffer.from('hello'));

    // Entries land in a sibling temporary file, so a truncated zip can never be mistaken for a
    // finished export at the path an operator was given. The temp file itself is not asserted:
    // the stream opens lazily, so its appearance is a race, while the output path staying empty
    // is the guarantee.
    expect(existsSync(output_path)).toBe(false);
    expect(readdirSync(dir).filter((name) => name === 'out.zip')).toEqual([]);
  });

  it('leaves no temporary file behind when the run aborts', async () => {
    const output_path = join(dir, 'partial.zip');
    const { archive, abort } = create_file_archive(output_path);
    await add_file_to_archive(archive, '/', 'report.txt', Buffer.from('hello'));

    await abort();

    expect(existsSync(output_path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('leaves the bytes of a pre-existing output file untouched when the run aborts', async () => {
    const output_path = join(dir, 'existing.zip');
    writeFileSync(output_path, 'someone else data');

    const { archive, abort } = create_file_archive(output_path);
    await add_file_to_archive(archive, '/', 'report.txt', Buffer.from('hello'));
    await abort();

    // Not just present: unchanged. Opening the output path for writing truncated it before
    // anything was written, so checking existence alone hid the loss.
    expect(readFileSync(output_path, 'utf-8')).toBe('someone else data');
  });

  it('replaces a pre-existing output file only on a successful publish', async () => {
    const output_path = join(dir, 'existing.zip');
    writeFileSync(output_path, 'someone else data');

    const { archive, promise, publish } = create_file_archive(output_path);
    await add_file_to_archive(archive, '/', 'report.txt', Buffer.from('hello'));
    await finalize_file_archive(archive);
    await promise;
    await publish();

    expect(readFileSync(output_path, 'utf-8')).not.toBe('someone else data');
    expect(readdirSync(dir)).toEqual(['existing.zip']);
  });

  it('does not raise when the archive is aborted twice', async () => {
    const output_path = join(dir, 'twice.zip');
    const { abort } = create_file_archive(output_path);

    await abort();
    await expect(abort()).resolves.toBeUndefined();
  });
});
