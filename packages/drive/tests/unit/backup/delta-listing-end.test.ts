import { describe, expect, it } from 'vitest';
import { assert_delta_listing_complete, final_delta_link } from '@/backup/delta-listing-end';
import { completed_recrawl } from '@/backup/recrawl-tombstones';

const DELTA_LINK = 'https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token=t2';

describe('final_delta_link (#852)', () => {
  it('returns the deltaLink of the page that ends the listing', () => {
    expect(final_delta_link({ '@odata.deltaLink': DELTA_LINK }, 'drive drive-1')).toBe(DELTA_LINK);
  });

  it.each([{}, { '@odata.deltaLink': '' }])('throws for a last page without one: %j', (page) => {
    expect(() => final_delta_link(page, 'drive drive-1')).toThrow(
      'Graph ended the delta listing of drive drive-1 without a delta link',
    );
  });
});

describe('assert_delta_listing_complete (#852)', () => {
  it('accepts a result that carries a delta link', () => {
    expect(() =>
      assert_delta_listing_complete({ delta_link: DELTA_LINK }, 'library drive-1'),
    ).not.toThrow();
  });

  it('throws for a result whose delta link is empty', () => {
    expect(() => assert_delta_listing_complete({ delta_link: '' }, 'library drive-1')).toThrow(
      /library drive-1 without a delta link/,
    );
  });
});

describe('completed_recrawl without a delta link (#852)', () => {
  const items = [{ item_id: 'a' }];

  it('is a finished full enumeration when the listing ended with a delta link', () => {
    const delta = { items, delta_link: DELTA_LINK, reset_detected: true };
    expect(completed_recrawl('drive-1', delta, 'old-link', false)?.returned_item_ids).toEqual(
      new Set(['a']),
    );
  });

  it.each([
    ['--full', undefined, false],
    ['a reset', 'old-link', true],
  ])('is not one after %s when the listing has no delta link', (_why, prev, reset_detected) => {
    const delta = { items, delta_link: '', reset_detected };
    expect(completed_recrawl('drive-1', delta, prev, false)).toBeUndefined();
  });
});
