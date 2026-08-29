import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mark_downloaded_from_internet } from '@/utils/zone-identifier';

const is_windows = platform() === 'win32';

let dir: string;
let archive: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-motw-'));
  archive = join(dir, 'export.zip');
  await writeFile(archive, 'PK\u0003\u0004 pretend archive');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mark_downloaded_from_internet', () => {
  it.skipIf(is_windows)('does nothing on platforms with no Mark-of-the-Web', async () => {
    const marked = await mark_downloaded_from_internet(archive);

    expect(marked).toBe(false);
  });

  it.skipIf(is_windows)(
    'creates no junk file, since a colon is an ordinary character here',
    async () => {
      // Without the platform gate this is what happens on macOS and Linux: a file
      // literally named "export.zip:Zone.Identifier" next to the archive.
      await mark_downloaded_from_internet(archive);

      expect(await readdir(dir)).toEqual(['export.zip']);
    },
  );

  it.skipIf(is_windows)('never throws for a path that cannot exist', async () => {
    await expect(mark_downloaded_from_internet(join(dir, 'gone', 'missing.zip'))).resolves.toBe(
      false,
    );
  });
});
