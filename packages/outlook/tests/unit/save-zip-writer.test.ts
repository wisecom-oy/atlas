import { describe, it, expect, afterEach } from 'vitest';
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  create_save_archive,
  add_eml_to_archive,
  finalize_archive,
} from '@/services/save/save-zip-writer';

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

    const { archive, promise } = create_save_archive(path);
    await add_eml_to_archive(archive, 'Inbox', 'test.eml', Buffer.from('EML content'));
    await finalize_archive(archive);
    const bytes = await promise;

    expect(existsSync(path)).toBe(true);
    expect(bytes).toBeGreaterThan(0);
  });

  it('creates valid archive with multiple entries', async () => {
    const path = temp_path('multi');
    created_files.push(path);

    const { archive, promise } = create_save_archive(path);
    await add_eml_to_archive(archive, 'Inbox', 'a.eml', Buffer.from('Message A'));
    await add_eml_to_archive(archive, 'Sent Items', 'b.eml', Buffer.from('Message B'));
    await add_eml_to_archive(archive, 'Inbox', 'c.eml', Buffer.from('Message C'));
    await finalize_archive(archive);
    const bytes = await promise;

    expect(bytes).toBeGreaterThan(0);
  });

  it('handles empty archive', async () => {
    const path = temp_path('empty');
    created_files.push(path);

    const { archive, promise } = create_save_archive(path);
    await finalize_archive(archive);
    const bytes = await promise;

    expect(bytes).toBeGreaterThan(0);
  });

  it('mirrors nested mail folders as nested zip directories', async () => {
    const path = temp_path('nested');
    created_files.push(path);

    const { archive, promise } = create_save_archive(path);
    const entries: string[] = [];
    archive.on('entry', (e) => entries.push(String(e.name)));

    await add_eml_to_archive(archive, 'Inbox/Projects/2026', 'a.eml', Buffer.from('A'));
    await add_eml_to_archive(archive, 'Archive/Projects/2026', 'b.eml', Buffer.from('B'));
    await finalize_archive(archive);
    await promise;

    expect(entries).toEqual(['Inbox/Projects/2026/a.eml', 'Archive/Projects/2026/b.eml']);
  });

  it('sanitizes each path segment without eating the separator', async () => {
    const path = temp_path('sanitize');
    created_files.push(path);

    const { archive, promise } = create_save_archive(path);
    const entries: string[] = [];
    archive.on('entry', (e) => entries.push(String(e.name)));

    await add_eml_to_archive(archive, 'Inbox/Q1:Q2/..', 'a.eml', Buffer.from('A'));
    await finalize_archive(archive);
    await promise;

    expect(entries).toEqual(['Inbox/Q1_Q2/Unknown/a.eml']);
  });
});
