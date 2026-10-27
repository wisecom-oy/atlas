import { describe, expect, it } from 'vitest';
import { canonical_site_id } from '@/services/shared/site-id';

const SITE_GUID = '11111111-1111-1111-1111-111111111111';
const WEB_GUID = '22222222-2222-2222-2222-222222222222';

describe('canonical_site_id', () => {
  it('keys a site the same before and after a SharePoint domain rename', () => {
    const before = canonical_site_id(`contoso.sharepoint.com,${SITE_GUID},${WEB_GUID}`);
    const after = canonical_site_id(`fabrikam.sharepoint.com,${SITE_GUID},${WEB_GUID}`);
    expect(before).toBe(`${SITE_GUID},${WEB_GUID}`);
    expect(after).toBe(before);
  });

  it('leaves an already canonical id unchanged, so storage-derived ids round-trip', () => {
    const canonical = `${SITE_GUID},${WEB_GUID}`;
    expect(canonical_site_id(canonical)).toBe(canonical);
    expect(canonical_site_id(canonical_site_id(canonical))).toBe(canonical);
  });
});
