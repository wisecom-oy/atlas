import { describe, it, expect, vi } from 'vitest';
import { AuthError, ThrottledError, type SharePointSite } from '@wisecom/atlas-types';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { enumerate_subsite_tree } from '@/adapters/graph-subsite-enumerator';

function site(id: string): SharePointSite {
  return { site_id: id, site_url: `https://contoso.sharepoint.com/sites/${id}`, display_name: id };
}

/** Fake Graph traversal: maps a site id to its direct subsites. */
function fetcher(tree: Record<string, SharePointSite[]>) {
  return vi.fn(async (site_id: string) => tree[site_id] ?? []);
}

/** A failed Graph call as the SDK surfaces it: an error carrying the HTTP status. */
function graph_error(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

describe('enumerate_subsite_tree', () => {
  it('returns nothing for a site without subsites', async () => {
    const result = await enumerate_subsite_tree('root', fetcher({}));

    expect(result.sites).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
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
    expect(result.errors).toEqual([]);
  });

  it('records a failed listing as an error naming the parent, not as a warning', async () => {
    const fetch_direct = vi.fn(async (site_id: string) => {
      if (site_id === 'root') return [site('locked'), site('open')];
      if (site_id === 'locked') throw new Error('Access is denied');
      return [];
    });

    const result = await enumerate_subsite_tree('root', fetch_direct);

    expect(result.sites.map((s) => s.site_id)).toEqual(['locked', 'open']);
    expect(result.warnings).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('locked');
    expect(result.errors[0]).toContain('Access is denied');
    expect(result.errors[0]).toContain('NOT covered');
  });

  it('records a 403 on the listing as an error and keeps the run going', async () => {
    const fetch_direct = vi.fn(async (site_id: string) => {
      if (site_id === 'root') return [site('locked'), site('open')];
      if (site_id === 'locked') throw graph_error(403, 'Access denied');
      if (site_id === 'open') return [site('open-child')];
      return [];
    });

    const result = await enumerate_subsite_tree('root', fetch_direct);

    expect(result.sites.map((s) => s.site_id)).toEqual(['locked', 'open', 'open-child']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('locked');
    expect(result.errors[0]).toContain('Access denied');
  });

  it('records a 429 that exhausted its retries as an error', async () => {
    const fetch_direct = vi.fn(async (site_id: string) => {
      if (site_id === 'root') return [site('busy')];
      throw new ThrottledError('Graph throttled the request after 12 retries');
    });

    const result = await enumerate_subsite_tree('root', fetch_direct);

    expect(result.sites.map((s) => s.site_id)).toEqual(['busy']);
    expect(result.warnings).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('throttled');
  });

  it('rejects with an AuthError when Graph refuses the token on the listing', async () => {
    const fetch_direct = vi.fn(async (site_id: string) => {
      if (site_id === 'root') return [site('a')];
      throw graph_error(401, 'InvalidAuthenticationToken');
    });

    await expect(enumerate_subsite_tree('root', fetch_direct)).rejects.toBeInstanceOf(AuthError);
  });

  it('rethrows a cancellation raised inside the listing instead of recording it', async () => {
    const controller = new AbortController();
    const reason = new Error('operator cancelled');
    const fetch_direct = vi.fn(async (site_id: string) => {
      if (site_id === 'root') {
        controller.abort(reason);
        throw reason;
      }
      return [];
    });

    const walk = run_with_abort_signal(controller.signal, () =>
      enumerate_subsite_tree('root', fetch_direct),
    );

    await expect(walk).rejects.toBe(reason);
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
