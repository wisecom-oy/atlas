import { describe, it, expect, afterEach } from 'vitest';
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  create_save_archive,
  add_eml_to_archive,
  finalize_archive,
} from '@/services/save/save-zip-writer';
import { build_eml_filename, deduplicate_filename } from '@/services/save/eml-builder';

function temp_path(name: string): string {
  return join(tmpdir(), `atlas-test-${Date.now()}-${name}.zip`);
}

describe('save-zip-writer', () => {
  const created_files: string[] = [];

  afterEach(() => {
    for (const f of created_files) {
      try {
        if (existsSync(f)) unlinkSync(f);
      } catch {
        /* cleanup best-effort */
      }
    }
    created_files.length = 0;
  });

  it('creates a zip file at the given path', async () => {
    const path = temp_path('create');
    created_files.push(path);

    const { archive, promise, publish } = create_save_archive(path);
    await add_eml_to_archive(archive, 'Inbox', 'test.eml', Buffer.from('EML content'));
    await finalize_archive(archive);
    const bytes = await promise;
    await publish();

    expect(existsSync(path)).toBe(true);
    expect(bytes).toBeGreaterThan(0);
  });

  it('creates valid archive with multiple entries', async () => {
    const path = temp_path('multi');
    created_files.push(path);

    const { archive, promise, publish } = create_save_archive(path);
    await add_eml_to_archive(archive, 'Inbox', 'a.eml', Buffer.from('Message A'));
    await add_eml_to_archive(archive, 'Sent Items', 'b.eml', Buffer.from('Message B'));
    await add_eml_to_archive(archive, 'Inbox', 'c.eml', Buffer.from('Message C'));
    await finalize_archive(archive);
    const bytes = await promise;
    await publish();

    expect(bytes).toBeGreaterThan(0);
  });

  it('handles empty archive', async () => {
    const path = temp_path('empty');
    created_files.push(path);

    const { archive, promise, publish } = create_save_archive(path);
    await finalize_archive(archive);
    const bytes = await promise;
    await publish();

    expect(bytes).toBeGreaterThan(0);
  });

  it('mirrors nested mail folders as nested zip directories', async () => {
    const path = temp_path('nested');
    created_files.push(path);

    const { archive, promise, publish } = create_save_archive(path);
    const entries: string[] = [];
    archive.on('entry', (e) => entries.push(String(e.name)));

    await add_eml_to_archive(archive, 'Inbox/Projects/2026', 'a.eml', Buffer.from('A'));
    await add_eml_to_archive(archive, 'Archive/Projects/2026', 'b.eml', Buffer.from('B'));
    await finalize_archive(archive);
    await promise;
    await publish();

    expect(entries).toEqual(['Inbox/Projects/2026/a.eml', 'Archive/Projects/2026/b.eml']);
  });

  it('sanitizes each path segment without eating the separator', async () => {
    const path = temp_path('sanitize');
    created_files.push(path);

    const { archive, promise, publish } = create_save_archive(path);
    const entries: string[] = [];
    archive.on('entry', (e) => entries.push(String(e.name)));

    await add_eml_to_archive(archive, 'Inbox/Q1:Q2/..', 'a.eml', Buffer.from('A'));
    await finalize_archive(archive);
    await promise;
    await publish();

    expect(entries).toEqual(['Inbox/Q1_Q2/Unknown/a.eml']);
  });

  // The file name derives from a message subject, so it is chosen by whoever sent the
  // mail. These cases pin the sanitisation at the archive boundary rather than trusting
  // the caller to have done it (issue #258).
  it('strips traversal from the file name instead of nesting the entry outside the folder', async () => {
    const path = temp_path('traversal');
    created_files.push(path);

    const { archive, promise, publish } = create_save_archive(path);
    const entries: string[] = [];
    archive.on('entry', (e) => entries.push(String(e.name)));

    await add_eml_to_archive(archive, 'Inbox', '../../../etc/passwd', Buffer.from('A'));
    await finalize_archive(archive);
    await promise;
    await publish();

    // Separators become underscores and `..` collapses to a single dot that is then
    // stripped from the front, so the whole name lands as one segment under the folder.
    expect(entries).toEqual(['Inbox/_._._etc_passwd']);
    expect(entries[0]).not.toContain('..');
    expect(entries[0]?.split('/')).toHaveLength(2);
  });

  it('flattens separators and control characters in the file name into one entry', async () => {
    const path = temp_path('flatten');
    created_files.push(path);

    const { archive, promise, publish } = create_save_archive(path);
    const entries: string[] = [];
    archive.on('entry', (e) => entries.push(String(e.name)));

    await add_eml_to_archive(archive, 'Inbox', 'a/b\\c\x01d.eml', Buffer.from('A'));
    await finalize_archive(archive);
    await promise;
    await publish();

    // One folder level plus one file: the name contributes no extra depth.
    expect(entries).toEqual(['Inbox/a_b_c_d.eml']);
    expect(entries[0]?.split('/')).toHaveLength(2);
  });

  // The constraint on issue #258: archives stay comparable across versions, so a name
  // that build_eml_filename produces must survive byte-identical.
  it('leaves generated .eml file names unchanged, including the untitled fallback', async () => {
    const path = temp_path('identity');
    created_files.push(path);

    const generated = [
      build_eml_filename('2026-03-10T14:30:22Z', 'Meeting with client'),
      build_eml_filename('2026-03-10T14:30:22Z', '<>:"/\\|?*'),
      build_eml_filename(undefined, undefined),
      deduplicate_filename(build_eml_filename('2026-03-10T14:30:22Z', 'Same'), new Set(['x'])),
    ];

    const { archive, promise, publish } = create_save_archive(path);
    const entries: string[] = [];
    archive.on('entry', (e) => entries.push(String(e.name)));

    for (const name of generated) {
      await add_eml_to_archive(archive, 'Inbox', name, Buffer.from('A'));
    }
    await finalize_archive(archive);
    await promise;
    await publish();

    expect(entries).toEqual(generated.map((n) => `Inbox/${n}`));
    expect(generated[1]).toContain('untitled');
    expect(generated.every((n) => n.endsWith('.eml'))).toBe(true);
  });
});
