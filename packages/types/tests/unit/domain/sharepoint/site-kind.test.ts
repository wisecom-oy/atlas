import { describe, expect, it } from 'vitest';
import { classify_site_kind, is_file_storage_container_site } from '@/domain/sharepoint/site-kind';

const CONTAINERS = [
  'https://contoso.sharepoint.com/contentstorage/CSP_00000000-0000-0000-0000-000000000000',
  'https://contoso.sharepoint.com/ContentStorage/CSP_x/',
  'https://contoso.sharepoint.com/CONTENTSTORAGE/CSP_x',
  'https://contoso.sharepoint.com//contentstorage/CSP_x',
];

const ORDINARY_SITES = [
  'https://contoso.sharepoint.com/',
  'https://contoso.sharepoint.com/sites/Engineering',
  'https://contoso.sharepoint.com/sites/contentstorage',
  'https://contoso.sharepoint.com/contentstorage-archive',
  'https://contoso-my.sharepoint.com/personal/user_contoso_com',
];

const NOT_URLS = [
  '',
  'not a url',
  '/contentstorage/CSP_x',
  'contoso.sharepoint.com/contentstorage',
];

describe('classify_site_kind', () => {
  it.each(CONTAINERS)('classifies %s as a SharePoint Embedded container', (url) => {
    expect(classify_site_kind(url)).toBe('file_storage_container');
  });

  it.each(ORDINARY_SITES)('classifies %s as an ordinary site', (url) => {
    expect(classify_site_kind(url)).toBe('site');
  });

  it.each(NOT_URLS)('classifies %j, which is not a URL, as an ordinary site', (value) => {
    expect(classify_site_kind(value)).toBe('site');
  });
});

describe('is_file_storage_container_site', () => {
  it('agrees with classify_site_kind on every case', () => {
    for (const url of [...CONTAINERS, ...ORDINARY_SITES, ...NOT_URLS]) {
      expect(is_file_storage_container_site(url)).toBe(
        classify_site_kind(url) === 'file_storage_container',
      );
    }
  });
});
