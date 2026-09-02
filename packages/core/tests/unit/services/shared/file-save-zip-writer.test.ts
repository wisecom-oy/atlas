import { existsSync, writeFileSync } from 'node:fs';
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
    const { archive, promise } = create_file_archive(output_path);

    await add_file_to_archive(archive, '/Documents', 'report.txt', Buffer.from('hello'));
    await finalize_file_archive(archive);

    expect(await promise).toBeGreaterThan(0);
    expect(existsSync(output_path)).toBe(true);
  });

  it('removes the partial file it created when the run aborts (issue #307)', async () => {
    const output_path = join(dir, 'partial.zip');
    const { archive, abort } = create_file_archive(output_path);
    await add_file_to_archive(archive, '/', 'report.txt', Buffer.from('hello'));

    // A truncated zip is indistinguishable from a complete one, so a failed save must leave
    // nothing behind rather than something that looks like an export.
    await abort();

    expect(existsSync(output_path)).toBe(false);
  });

  it('keeps a file that already existed at the output path', async () => {
    const output_path = join(dir, 'existing.zip');
    writeFileSync(output_path, 'someone else data');

    const { abort } = create_file_archive(output_path);
    await abort();

    // The caller may have been handed the path of something unrelated; deleting it would be
    // destroying data the save was never asked to touch.
    expect(existsSync(output_path)).toBe(true);
  });

  it('does not raise when the archive is aborted twice', async () => {
    const output_path = join(dir, 'twice.zip');
    const { abort } = create_file_archive(output_path);

    await abort();
    await expect(abort()).resolves.toBeUndefined();
  });
});
