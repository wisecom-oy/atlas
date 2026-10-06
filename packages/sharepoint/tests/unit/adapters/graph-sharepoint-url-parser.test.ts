import { describe, expect, it } from 'vitest';
import { parse_site_reference } from '@/adapters/graph-sharepoint-url-parser';

describe('parse_site_reference', () => {
  it.each([
    ['https://contoso.sharepoint.com/sites/Example', 'contoso.sharepoint.com:/sites/Example'],
    [
      'HTTPS://contoso.sharepoint.com/sites/Example/Sub',
      'contoso.sharepoint.com:/sites/Example/Sub',
    ],
    ['https://contoso.sharepoint.com/', 'contoso.sharepoint.com'],
    ['https://contoso.sharepoint.com', 'contoso.sharepoint.com'],
  ])('turns the full URL %s into %s', (input, expected) => {
    expect(parse_site_reference(input)).toBe(expected);
  });

  it.each([
    ['a hostname:/path reference', 'contoso.sharepoint.com:/sites/Example'],
    [
      'a composite site id',
      'contoso.sharepoint.com,11111111-2222-3333-4444-555555555555,66666666-7777-8888-9999-000000000000',
    ],
    ['a bare site GUID', '11111111-2222-3333-4444-555555555555'],
  ])('passes %s through unchanged', (_label, input) => {
    expect(parse_site_reference(input)).toBe(input);
  });

  it('passes an unparseable URL through for Graph to reject', () => {
    expect(parse_site_reference('https://')).toBe('https://');
  });
});
