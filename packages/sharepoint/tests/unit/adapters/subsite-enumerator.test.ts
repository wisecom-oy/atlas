import { describe, it, expect, vi } from 'vitest';
import type { SharePointSite } from '@wisecom/atlas-types';
import { enumerate_subsite_tree } from '@/adapters/graph-subsite-enumerator';

function site(id: string): SharePointSite {
  return { site_id: id, site_url: `https://contoso.sharepoint.com/sites/${id}`, display_name: id };
}

/** Fake Graph traversal: maps a site id to its direct subsites. */
function fetcher(tree: Record<string, SharePointSite[]>) {
  return vi.fn(async (site_id: string) => tree[site_id] ?? []);
}

describe('enumerate_subsite_tree', () => {
  it('returns nothing for a site without subsites', async () => {
    const result = await enumerate_subsite_tree('root', fetcher({}));

    expect(result.sites).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('collects subsites at every level', async () => {
    const result = await enumerate_subsite_tree(
      'root',
      fetcher({
        root: [site('a'), site('b')],
        a: [site('a1')],
        a1: [site('a1x')],
      }),
    );

    expect(result.sites.map((s) => s.site_id).sort()).toEqual(['a', 'a1', 'a1x', 'b']);
    expect(result.warnings).toEqual([]);
  });

  it('reports an inaccessible subtree instead of treating it as empty', async () => {
    const fetch_direct = vi.fn(async (site_id: string) => {
      if (site_id === 'root') return [site('locked'), site('open')];
      if (site_id === 'locked') throw new Error('Access is denied');
      return [];
    });

    const result = await enumerate_subsite_tree('root', fetch_direct);

    expect(result.sites.map((s) => s.site_id)).toEqual(['locked', 'open']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Access is denied');
    expect(result.warnings[0]).toContain('NOT covered');
  });

  it('keeps walking siblings after one subtree fails', async () => {
    const fetch_direct = vi.fn(async (site_id: string) => {
      if (site_id === 'root') return [site('bad'), site('good')];
      if (site_id === 'bad') throw new Error('boom');
      if (site_id === 'good') return [site('good-child')];
      return [];
    });

    const result = await enumerate_subsite_tree('root', fetch_direct);

    expect(result.sites.map((s) => s.site_id)).toContain('good-child');
  });

  it('does not revisit a site reachable twice', async () => {
    const fetch_direct = fetcher({
      root: [site('a'), site('b')],
      a: [site('shared')],
      b: [site('shared')],
    });

    const result = await enumerate_subsite_tree('root', fetch_direct);

    expect(result.sites.filter((s) => s.site_id === 'shared')).toHaveLength(1);
  });

  it('stops and warns when nesting exceeds the depth ceiling', async () => {
    // Every site reports one deeper child, so only the cap can end the walk.
    const fetch_direct = vi.fn(async (site_id: string) => [site(`${site_id}-deeper`)]);

    const result = await enumerate_subsite_tree('root', fetch_direct);

    expect(result.sites).toHaveLength(20);
    expect(result.warnings.join(' ')).toContain('exceeded 20 levels');
  });
});
