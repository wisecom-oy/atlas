import { describe, expect, it } from 'vitest';
import { classify_site_kind } from '@/services/shared/site-kind';

describe('classify_site_kind', () => {
  it.each([
    'https://contoso.sharepoint.com/contentstorage/CSP_00000000-0000-0000-0000-000000000000',
    'https://contoso.sharepoint.com/ContentStorage/CSP_x/',
  ])('classifies %s as a SharePoint Embedded container', (url) => {
    expect(classify_site_kind(url)).toBe('file_storage_container');
  });

  it.each([
    'https://contoso.sharepoint.com/',
    'https://contoso.sharepoint.com/sites/Engineering',
    'https://contoso.sharepoint.com/sites/contentstorage',
    'https://contoso-my.sharepoint.com/personal/user_contoso_com',
    '',
    'not a url',
  ])('classifies %s as an ordinary site', (url) => {
    expect(classify_site_kind(url)).toBe('site');
  });
});
