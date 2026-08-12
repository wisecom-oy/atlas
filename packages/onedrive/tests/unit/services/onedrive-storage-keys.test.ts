/**
 * Issue #38: two spellings of one owner used to write two key prefixes -- the
 * same drive stored twice, and a delete that erased whichever spelling it was
 * handed while the other survived.
 */
import { describe, it, expect } from 'vitest';
import {
  onedrive_data_key,
  onedrive_manifest_key,
  onedrive_manifest_prefix,
  onedrive_index_key,
  onedrive_index_prefix,
  onedrive_staging_key,
  onedrive_staging_prefix,
  onedrive_delta_cursor_key,
} from '@/services/onedrive-storage-keys';

const LOWER = '75a21b57-4d82-4f42-9ccc-7c231c30f78c';
const UPPER = LOWER.toUpperCase();

describe('owner segment normalization', () => {
  it('builds one key for either spelling of the owner', () => {
    expect(onedrive_data_key(UPPER, 'abc')).toBe(onedrive_data_key(LOWER, 'abc'));
    expect(onedrive_manifest_key(UPPER, 'snap-1')).toBe(onedrive_manifest_key(LOWER, 'snap-1'));
    expect(onedrive_manifest_prefix(UPPER)).toBe(onedrive_manifest_prefix(LOWER));
    expect(onedrive_index_key(UPPER, 'f1')).toBe(onedrive_index_key(LOWER, 'f1'));
    expect(onedrive_index_prefix(UPPER)).toBe(onedrive_index_prefix(LOWER));
    expect(onedrive_staging_prefix(UPPER)).toBe(onedrive_staging_prefix(LOWER));
    expect(onedrive_delta_cursor_key(UPPER)).toBe(onedrive_delta_cursor_key(LOWER));
  });

  it('leaves the owner in the case the deletion prefixes expect', () => {
    expect(onedrive_data_key(UPPER, 'abc')).toBe(`onedrive/data/${LOWER}/abc`);
  });

  it('preserves the case of a Graph item id, which is case-sensitive', () => {
    // A drive item id like 01URRJBN4NAEKTKQYT7BBJABARSNLVA5H3 must survive intact.
    const item_id = '01URRJBN4NAEKTKQYT7BBJABARSNLVA5H3';
    expect(onedrive_staging_key(UPPER, item_id)).toContain(`/${item_id}-`);
    expect(onedrive_index_key(UPPER, item_id)).toContain(`/${item_id}.json`);
  });

  it('still rejects a traversal segment', () => {
    expect(() => onedrive_data_key('..', 'abc')).toThrow(/Invalid storage key segment/);
    expect(() => onedrive_data_key('a/b', 'abc')).toThrow(/Invalid storage key segment/);
  });
});
