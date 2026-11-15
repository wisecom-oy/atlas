import { describe, expect, it } from 'vitest';
import { sanitize_graph_permissions } from '@/permissions/permission-sanitizer';
import { digest_permissions } from '@/permissions/permission-digest';

/** Graph `permission` resources in the shapes a live tenant returned, with placeholder values. */
const USER = { id: 'user-object-id', displayName: 'Jane Roe', email: 'jane.roe@example.com' };
const SITE_USER = { id: '7', displayName: 'Jane Roe', loginName: 'i:0#.f|membership|jane' };

const ANONYMOUS_LINK = {
  id: 'perm-link',
  roles: ['read'],
  shareId: 'u!secret-share-id',
  hasPassword: true,
  expirationDateTime: '2027-01-01T00:00:00Z',
  link: {
    type: 'view',
    scope: 'anonymous',
    webUrl: 'https://contoso.sharepoint.com/:t:/g/personal/secret-token',
    preventsDownload: false,
  },
  invitation: { signInRequired: false, email: 'jane.roe@example.com' },
  grantedToIdentitiesV2: [],
};
const DIRECT_GRANT = {
  id: 'perm-grant',
  roles: ['write'],
  grantedToV2: { user: USER, siteUser: SITE_USER },
  grantedTo: { user: USER },
};
const PEOPLE_LINK = {
  id: 'perm-people',
  roles: ['read'],
  hasPassword: false,
  link: { scope: 'users', type: 'view', webUrl: 'https://contoso.sharepoint.com/x?share=abc' },
  grantedToIdentitiesV2: [{ user: USER, siteUser: SITE_USER }],
};
const INHERITED_OWNER = {
  id: 'perm-owner',
  roles: ['owner'],
  grantedToV2: { user: USER },
  inheritedFrom: {},
};

describe('sanitize_graph_permissions (#580)', () => {
  it('keeps no URL, share id, invitation or token from any permission', () => {
    const kept = sanitize_graph_permissions([ANONYMOUS_LINK, DIRECT_GRANT, PEOPLE_LINK]);
    const stored = JSON.stringify(kept);

    expect(stored).not.toMatch(/https?:/);
    expect(stored).not.toContain('webUrl');
    expect(stored).not.toContain('shareId');
    expect(stored).not.toContain('secret');
    expect(stored).not.toContain('invitation');
    expect(stored).not.toContain('share=');
  });

  it('records a link by type, scope, expiry and password flag', () => {
    expect(sanitize_graph_permissions([ANONYMOUS_LINK])).toEqual([
      {
        roles: ['read'],
        link: { type: 'view', scope: 'anonymous' },
        expires_at: '2027-01-01T00:00:00Z',
        has_password: true,
      },
    ]);
  });

  it('records a direct grant against the Entra user, with the SharePoint login name alongside', () => {
    expect(sanitize_graph_permissions([DIRECT_GRANT])).toEqual([
      {
        roles: ['write'],
        granted_to: {
          type: 'user',
          id: 'user-object-id',
          display_name: 'Jane Roe',
          email: 'jane.roe@example.com',
          login_name: 'i:0#.f|membership|jane',
        },
      },
    ]);
  });

  it('records who a specific-people link was shared with', () => {
    const [link] = sanitize_graph_permissions([PEOPLE_LINK]);
    expect(link?.granted_to_identities).toEqual([
      expect.objectContaining({ type: 'user', id: 'user-object-id' }),
    ]);
  });

  it('drops inherited permissions, including the root marker `inheritedFrom: {}`', () => {
    expect(sanitize_graph_permissions([INHERITED_OWNER])).toEqual([]);
  });

  it('classifies site groups and applications', () => {
    const kept = sanitize_graph_permissions([
      { roles: ['read'], grantedToV2: { siteGroup: { id: '3', displayName: 'Visitors' } } },
      { roles: ['owner'], grantedToV2: { application: { id: 'app-id' } } },
    ]);
    expect(kept.map((p) => p.granted_to?.type)).toEqual(['site_group', 'application']);
  });

  it('skips values that are not permission objects or carry no roles', () => {
    expect(sanitize_graph_permissions([null, 'x', { roles: [] }, { link: {} }])).toEqual([]);
  });
});

describe('digest_permissions', () => {
  it('is independent of the order Graph lists permissions in', () => {
    const a = sanitize_graph_permissions([DIRECT_GRANT, PEOPLE_LINK]);
    const b = sanitize_graph_permissions([PEOPLE_LINK, DIRECT_GRANT]);
    expect(digest_permissions(a)).toBe(digest_permissions(b));
  });

  it('changes when a role changes', () => {
    const before = sanitize_graph_permissions([DIRECT_GRANT]);
    const after = sanitize_graph_permissions([{ ...DIRECT_GRANT, roles: ['read'] }]);
    expect(digest_permissions(before)).not.toBe(digest_permissions(after));
  });
});
