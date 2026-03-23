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
});
