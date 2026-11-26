import { describe, expect, it } from 'vitest';
import { ListingIncompleteError } from '@wisecom/atlas-types';
import {
  assert_listing_complete,
  reported_collection_count,
  with_collection_count,
} from '@/graph-counted-listing';

describe('with_collection_count', () => {
  it('adds $count=true to a URL with or without a query string', () => {
    expect(with_collection_count('/teams')).toBe('/teams?$count=true');
    expect(with_collection_count('/teams?$select=id')).toBe('/teams?$select=id&$count=true');
  });
});

describe('reported_collection_count', () => {
  it('reads @odata.count from a page', () => {
    expect(reported_collection_count({ value: [], '@odata.count': 7 }, undefined)).toBe(7);
  });

  it('keeps the earlier count when a page carries none or a malformed one', () => {
    expect(reported_collection_count({ value: [] }, 4)).toBe(4);
    expect(reported_collection_count({ '@odata.count': '9' }, 4)).toBe(4);
    expect(reported_collection_count({ '@odata.count': -1 }, 4)).toBe(4);
    expect(reported_collection_count(undefined, undefined)).toBeUndefined();
  });
});

describe('assert_listing_complete', () => {
  it('accepts a listing that holds as many items as counted, or more', () => {
    expect(() => assert_listing_complete('teams', 3, 3)).not.toThrow();
    expect(() => assert_listing_complete('teams', 4, 3)).not.toThrow();
    expect(() => assert_listing_complete('teams', 0, 0)).not.toThrow();
  });

  it('refuses a listing with fewer items than counted', () => {
    expect(() => assert_listing_complete('teams', 2, 3)).toThrow(ListingIncompleteError);
    expect(() => assert_listing_complete('teams', 2, 3)).toThrow(
      'Microsoft Graph listed 2 of 3 teams: the listing ended before its last page',
    );
  });

  it('accepts a listing that carried no count, since that endpoint cannot be checked', () => {
    expect(() => assert_listing_complete('teams', 2, undefined)).not.toThrow();
  });
});
