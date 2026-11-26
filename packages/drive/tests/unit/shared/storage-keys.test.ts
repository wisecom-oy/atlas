import { describe, expect, it } from 'vitest';
import { build_drive_storage_keys } from '@/shared/storage-keys';

const keys = build_drive_storage_keys('sharepoint');

describe('build_drive_storage_keys part keys (#920)', () => {
  it('numbers manifest parts under their own prefix, outside the manifest listing', () => {
    expect(keys.manifest_part_key('Site-A', 'sp-snap-1-abc', 7)).toBe(
      'sharepoint/manifest-parts/site-a/sp-snap-1-abc/00007.json',
    );
    expect(keys.manifest_snapshot_parts_prefix('site-a', 'sp-snap-1-abc')).toBe(
      'sharepoint/manifest-parts/site-a/sp-snap-1-abc/',
    );
    expect(keys.manifest_parts_prefix_for('SITE-A')).toBe('sharepoint/manifest-parts/site-a/');
    expect(
      keys
        .manifest_part_key('site-a', 'sp-snap-1-abc', 0)
        .startsWith(keys.manifest_prefix_for('site-a')),
    ).toBe(false);
  });

  it('refuses a part index or snapshot id that would escape the snapshot prefix', () => {
    expect(() => keys.manifest_part_key('site-a', 'sp-snap-1-abc', -1)).toThrow('part index');
    expect(() => keys.manifest_part_key('site-a', 'sp-snap-1-abc', 1.5)).toThrow('part index');
    expect(() => keys.manifest_part_key('site-a', '../x', 0)).toThrow(
      'Invalid storage key segment',
    );
  });

  it('keeps the cursor head and parts beside delta.json, under the state prefix', () => {
    expect(keys.delta_cursor_key('Site-A')).toBe('sharepoint/_meta/site-a/delta.json');
    expect(keys.delta_cursor_head_key('Site-A')).toBe('sharepoint/_meta/site-a/delta/head.json');
    expect(keys.delta_cursor_part_key('site-a', 'ab12')).toBe(
      'sharepoint/_meta/site-a/delta/parts/ab12.json',
    );
    expect(() => keys.delta_cursor_part_key('site-a', 'a/b')).toThrow(
      'Invalid storage key segment',
    );
  });

  it('works as detached functions, the way provider packages re-export them', () => {
    const { manifest_part_key, delta_cursor_head_key } = keys;

    expect(manifest_part_key('site-a', 'sp-snap-1-abc', 0)).toContain('/00000.json');
    expect(delta_cursor_head_key('site-a')).toContain('/delta/head.json');
  });
});
