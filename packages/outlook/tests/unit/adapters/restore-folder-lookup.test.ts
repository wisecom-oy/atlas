import { describe, expect, it, vi } from 'vitest';
import {
  find_child_folder_by_name,
  find_well_known_role,
} from '@/adapters/graph-restore-folder-lookup';

/**
 * Issue #684: the lookup that lets a restore reuse its destination. Exchange compares folder
 * names case-insensitively, so an exact-match lookup would miss `Recovered` when asked for
 * `recovered`, and the create that follows would be refused.
 */

describe('find_child_folder_by_name', () => {
  it('lists the top level when there is no parent and matches case-insensitively', async () => {
    const get = vi.fn().mockResolvedValue({
      value: [
        { id: 'a', displayName: 'Archive' },
        { id: 'r', displayName: 'Recovered', totalItemCount: 4 },
      ],
    });

    const found = await find_child_folder_by_name(get, 'user@example.com', 'RECOVERED');

    expect(get.mock.calls[0]?.[0]).toMatch(/^\/users\/user@example\.com\/mailFolders\?\$select=/);
    expect(found).toEqual({
      folder_id: 'r',
      display_name: 'Recovered',
      folder_path: 'Recovered',
      parent_folder_id: undefined,
      total_item_count: 4,
    });
  });

  it('lists the children of a parent and follows nextLink until it finds the name', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        value: [{ id: 'x', displayName: 'Other' }],
        '@odata.nextLink': 'next',
      })
      .mockResolvedValueOnce({ value: [{ id: 'p', displayName: 'Projects' }] });

    const found = await find_child_folder_by_name(get, 'u', 'Projects', 'parent-1');

    expect(get.mock.calls.map(([url]) => url)).toEqual([
      expect.stringMatching(/^\/users\/u\/mailFolders\/parent-1\/childFolders\?/),
      'next',
    ]);
    expect(found?.folder_id).toBe('p');
    expect(found?.parent_folder_id).toBe('parent-1');
  });

  it('returns undefined when no page holds the name', async () => {
    const get = vi.fn().mockResolvedValue({ value: [{ id: 'x', displayName: 'Other' }] });

    await expect(find_child_folder_by_name(get, 'u', 'Recovered')).resolves.toBeUndefined();
  });

  it('does not request hidden folders, so a restore never lands in one', async () => {
    const get = vi.fn().mockResolvedValue({ value: [] });

    await find_child_folder_by_name(get, 'u', 'Recovered');

    expect(get.mock.calls[0]?.[0]).not.toContain('includeHiddenFolders');
  });
});

describe('find_well_known_role', () => {
  it('names the role whose id matches, whatever the localized display name', async () => {
    const read = vi.fn(async (name: string) =>
      name === 'inbox' ? { id: 'inbox-id', displayName: 'Saapuneet' } : { id: `${name}-id` },
    );

    await expect(find_well_known_role(read, 'inbox-id')).resolves.toBe('inbox');
  });

  it('returns undefined for an ordinary folder', async () => {
    const read = vi.fn(async (name: string) => ({ id: `${name}-id` }));

    await expect(find_well_known_role(read, 'recovered-id')).resolves.toBeUndefined();
  });

  it('propagates a failed read rather than letting a well-known folder through', async () => {
    const read = vi.fn().mockRejectedValue(new Error('503'));

    await expect(find_well_known_role(read, 'any')).rejects.toThrow('503');
  });
});
