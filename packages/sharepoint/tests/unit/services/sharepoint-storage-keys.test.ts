import { describe, it, expect } from 'vitest';
import {
  sharepoint_data_key,
  sharepoint_manifest_key,
  sharepoint_manifest_prefix,
  sharepoint_index_key,
  sharepoint_index_prefix,
  sharepoint_staging_key,
  sharepoint_staging_prefix,
  sharepoint_delta_cursor_key,
  validate_key_segment,
} from '@/services/sharepoint-storage-keys';

describe('validate_key_segment', () => {
  it('rejects empty string', () => {
    expect(() => validate_key_segment('')).toThrow('Invalid storage key segment');
  });

  it('rejects dot', () => {
    expect(() => validate_key_segment('.')).toThrow();
  });

  it('rejects double dot', () => {
    expect(() => validate_key_segment('..')).toThrow();
  });

  it('rejects forward slash', () => {
    expect(() => validate_key_segment('a/b')).toThrow();
  });

  it('rejects backslash', () => {
    expect(() => validate_key_segment('a\\b')).toThrow();
  });

  it('rejects null byte', () => {
    expect(() => validate_key_segment('a\0b')).toThrow();
  });

  it('accepts valid segments', () => {
    expect(() => validate_key_segment('abc123')).not.toThrow();
    expect(() => validate_key_segment('site-id-with-dashes')).not.toThrow();
  });
});

describe('sharepoint_data_key', () => {
  it('builds content-addressed key', () => {
    expect(sharepoint_data_key('site-1', 'sha256abc')).toBe('sharepoint/data/site-1/sha256abc');
  });
});

describe('sharepoint_manifest_key', () => {
  it('builds manifest key with .json extension', () => {
    expect(sharepoint_manifest_key('site-1', 'snap-001')).toBe(
      'sharepoint/manifests/site-1/snap-001.json',
    );
  });
});

describe('sharepoint_manifest_prefix', () => {
  it('builds prefix for listing', () => {
    expect(sharepoint_manifest_prefix('site-1')).toBe('sharepoint/manifests/site-1/');
  });
});

describe('sharepoint_index_key', () => {
  it('builds file version index key', () => {
    expect(sharepoint_index_key('site-1', 'file-abc')).toBe(
      'sharepoint/index/site-1/files/file-abc.json',
    );
  });
});

describe('sharepoint_index_prefix', () => {
  it('builds prefix for listing file indexes', () => {
    expect(sharepoint_index_prefix('site-1')).toBe('sharepoint/index/site-1/files/');
  });
});

describe('sharepoint_staging_key', () => {
  it('includes random suffix for uniqueness', () => {
    const key1 = sharepoint_staging_key('site-1', 'item-1');
    const key2 = sharepoint_staging_key('site-1', 'item-1');
    expect(key1).toMatch(/^sharepoint\/staging\/site-1\/item-1-[0-9a-f]{8}$/);
    expect(key1).not.toBe(key2);
  });
});

describe('sharepoint_staging_prefix', () => {
  it('builds prefix for listing staging objects', () => {
    expect(sharepoint_staging_prefix('site-1')).toBe('sharepoint/staging/site-1/');
  });
});

describe('sharepoint_delta_cursor_key', () => {
  it('builds the cursor key', () => {
    expect(sharepoint_delta_cursor_key('site-1')).toBe('sharepoint/_meta/site-1/delta.json');
  });
});
