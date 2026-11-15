import { describe, expect, it } from 'vitest';
import { graph_error, stub_graph_client } from '@wisecom/atlas-types/testing/stub-graph-client';
import {
  graph_create_item_link,
  graph_grant_item_access,
} from '@/permissions/graph-sharing-writes';

describe('graph_grant_item_access (#580)', () => {
  it('invites by object id without an invitation email and with sign-in required', async () => {
    const stub = stub_graph_client(() => ({ value: [] }));

    const outcome = await graph_grant_item_access(stub.client, 'drive-1', 'item-1', {
      recipient: { object_id: 'user-object-id' },
      roles: ['write'],
    });

    expect(outcome).toEqual({ status: 'applied' });
    expect(stub.calls).toEqual([
      {
        method: 'post',
        url: '/drives/drive-1/items/item-1/invite',
        body: {
          recipients: [{ objectId: 'user-object-id' }],
          roles: ['write'],
          sendInvitation: false,
          requireSignIn: true,
        },
      },
    ]);
  });

  it('reports a principal that no longer resolves as a refusal, not a failure', async () => {
    const stub = stub_graph_client(() => {
      throw graph_error(400, 'invalidRequest', 'One or more users could not be resolved');
    });

    const outcome = await graph_grant_item_access(stub.client, 'drive-1', 'item-1', {
      recipient: { email: 'gone@example.com' },
      roles: ['read'],
    });

    expect(outcome).toMatchObject({ status: 'refused', refusal: 'principal_unresolved' });
  });
});

describe('graph_create_item_link (#580)', () => {
  it('asks for the stored type and scope and never sends or reads a URL', async () => {
    const stub = stub_graph_client(() => ({
      link: { webUrl: 'https://contoso.sharepoint.com/:x:/new-link' },
    }));

    const outcome = await graph_create_item_link(stub.client, 'drive-1', 'item-1', {
      type: 'view',
      scope: 'users',
      expires_at: '2027-01-01T00:00:00Z',
      recipients: [{ object_id: 'u-1' }, { email: 'jane.roe@example.com' }],
    });

    expect(outcome).toEqual({ status: 'applied' });
    expect(stub.calls[0]?.body).toEqual({
      type: 'view',
      scope: 'users',
      expirationDateTime: '2027-01-01T00:00:00Z',
      recipients: [{ objectId: 'u-1' }, { email: 'jane.roe@example.com' }],
    });
  });

  it('reports an anonymous link a tenant forbids as sharing disabled', async () => {
    const stub = stub_graph_client(() => {
      throw graph_error(
        403,
        'notAllowed',
        'The operation failed because sharing has been disabled on this site.',
      );
    });

    const outcome = await graph_create_item_link(stub.client, 'drive-1', 'item-1', {
      type: 'view',
      scope: 'anonymous',
    });

    expect(outcome).toMatchObject({ status: 'refused', refusal: 'sharing_disabled' });
  });
});
