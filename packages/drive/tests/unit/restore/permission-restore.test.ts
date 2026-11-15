import { describe, expect, it, vi } from 'vitest';
import type { DrivePermission, DriveSharingWriteOutcome } from '@wisecom/atlas-types';
import { restore_item_permissions, type PermissionWriter } from '@/restore/permission-restore';
import { SharingRestoreTally } from '@/restore/sharing-restore-tally';

const TARGET = { drive_id: 'drive-1', item_id: 'item-1', path: '/Projects/plan.docx' };
const NOW = new Date('2026-11-15T00:00:00Z');
const APPLIED: DriveSharingWriteOutcome = { status: 'applied' };
const UNRESOLVED: DriveSharingWriteOutcome = {
  status: 'refused',
  refusal: 'principal_unresolved',
  message: 'One or more users could not be resolved',
};

function writer(
  grant: (recipient: unknown) => DriveSharingWriteOutcome = () => APPLIED,
  link: () => DriveSharingWriteOutcome = () => APPLIED,
): PermissionWriter & { grant_item_access: ReturnType<typeof vi.fn> } {
  return {
    grant_item_access: vi.fn(async (_d: string, _i: string, request: { recipient: unknown }) =>
      grant(request.recipient),
    ),
    create_item_link: vi.fn(async () => link()),
  };
}

const jane_grant: DrivePermission = {
  roles: ['write'],
  granted_to: { type: 'user', id: 'jane-id', email: 'jane.roe@example.com' },
};

describe('restore_item_permissions (#580)', () => {
  it('reapplies a direct grant by object id with the same role', async () => {
    const graph = writer();
    const tally = new SharingRestoreTally();

    await restore_item_permissions(graph, TARGET, [jane_grant], tally, NOW);

    expect(graph.grant_item_access).toHaveBeenCalledWith('drive-1', 'item-1', {
      recipient: { object_id: 'jane-id' },
      roles: ['write'],
    });
    expect(tally.summary()).toEqual({ permissions_applied: 1 });
  });

  it('falls back to the address when the object id no longer resolves', async () => {
    const graph = writer((recipient) =>
      'object_id' in (recipient as object) ? UNRESOLVED : APPLIED,
    );
    const tally = new SharingRestoreTally();

    await restore_item_permissions(graph, TARGET, [jane_grant], tally, NOW);

    expect(graph.grant_item_access).toHaveBeenLastCalledWith('drive-1', 'item-1', {
      recipient: { email: 'jane.roe@example.com' },
      roles: ['write'],
    });
    expect(tally.summary().permissions_applied).toBe(1);
  });

  it('reports a deleted grantee per permission and carries on with the rest', async () => {
    const graph = writer(() => UNRESOLVED);
    const tally = new SharingRestoreTally();
    const link: DrivePermission = {
      roles: ['read'],
      link: { type: 'view', scope: 'organization' },
    };

    await restore_item_permissions(graph, TARGET, [jane_grant, link], tally, NOW);

    expect(tally.summary()).toEqual({
      permissions_applied: 1,
      permissions_skipped: 1,
      skipped_items: [
        {
          path: '/Projects/plan.docx',
          kind: 'permission',
          detail: 'grant write to jane-id <jane.roe@example.com>',
          reason: 'grantee no longer exists or cannot be resolved in this tenant',
        },
      ],
    });
  });

  it('never re-grants owner and leaves it out of every count', async () => {
    const graph = writer();
    const tally = new SharingRestoreTally();
    const owner: DrivePermission = { roles: ['owner'], granted_to: { type: 'user', id: 'me' } };

    await restore_item_permissions(graph, TARGET, [owner], tally, NOW);

    expect(graph.grant_item_access).not.toHaveBeenCalled();
    expect(tally.summary()).toEqual({});
  });

  it('skips expired and password-protected links instead of reopening them', async () => {
    const graph = writer();
    const tally = new SharingRestoreTally();

    await restore_item_permissions(
      graph,
      TARGET,
      [
        {
          roles: ['read'],
          link: { type: 'view', scope: 'organization' },
          expires_at: '2026-01-01T00:00:00Z',
        },
        { roles: ['read'], link: { type: 'view', scope: 'anonymous' }, has_password: true },
      ],
      tally,
      NOW,
    );

    expect(graph.create_item_link).not.toHaveBeenCalled();
    expect(tally.summary().skipped_items?.map((item) => item.reason)).toEqual([
      'expired',
      'password-protected link; the password cannot be restored',
    ]);
  });

  it('recreates a specific-people link with its recipients and future expiry', async () => {
    const graph = writer();
    const tally = new SharingRestoreTally();

    await restore_item_permissions(
      graph,
      TARGET,
      [
        {
          roles: ['read'],
          link: { type: 'view', scope: 'users' },
          expires_at: '2027-06-01T00:00:00Z',
          granted_to_identities: [
            { type: 'user', id: 'jane-id' },
            { type: 'site_user', email: 'x@example.com' },
          ],
        },
      ],
      tally,
      NOW,
    );

    expect(graph.create_item_link).toHaveBeenCalledWith('drive-1', 'item-1', {
      type: 'view',
      scope: 'users',
      expires_at: '2027-06-01T00:00:00Z',
      recipients: [{ object_id: 'jane-id' }, { email: 'x@example.com' }],
    });
  });

  it('reports a link the tenant forbids as skipped with the policy reason', async () => {
    const graph = writer(undefined, () => ({
      status: 'refused',
      refusal: 'sharing_disabled',
      message: 'sharing has been disabled',
    }));
    const tally = new SharingRestoreTally();

    await restore_item_permissions(
      graph,
      TARGET,
      [{ roles: ['read'], link: { type: 'view', scope: 'anonymous' } }],
      tally,
      NOW,
    );

    expect(tally.summary().skipped_items?.[0]?.reason).toBe(
      'sharing of this kind is disabled by tenant or site policy',
    );
  });

  it('skips SharePoint site groups with a reason', async () => {
    const graph = writer();
    const tally = new SharingRestoreTally();

    await restore_item_permissions(
      graph,
      TARGET,
      [{ roles: ['read'], granted_to: { type: 'site_group', id: '3', display_name: 'Visitors' } }],
      tally,
      NOW,
    );

    expect(graph.grant_item_access).not.toHaveBeenCalled();
    expect(tally.summary().skipped_items?.[0]?.reason).toMatch(/site group/);
  });
});
