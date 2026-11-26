import { describe, expect, it } from 'vitest';
import {
  AuthError,
  MailboxNotLicensedError,
  MissingGraphPermissionsError,
} from '@wisecom/atlas-types';
import { graph_error } from '@wisecom/atlas-types/testing/stub-graph-client';
import {
  is_missing_grant_refusal,
  rethrow_if_access_denied,
  rethrow_if_mailbox_not_licensed,
  rethrow_if_teams_access_denied,
} from '@/graph-permission-errors';

/** Runs a helper and returns what it threw, or undefined when it returned. */
function thrown_by(rethrow: (err: unknown) => void, err: unknown): unknown {
  try {
    rethrow(err);
    return undefined;
  } catch (caught) {
    return caught;
  }
}

const HELPERS = [
  ['rethrow_if_access_denied', (err: unknown) => rethrow_if_access_denied(err)],
  ['rethrow_if_teams_access_denied', rethrow_if_teams_access_denied],
] as const;

// Issue #865: only a 403 whose code means a missing grant stops the run as an AuthError.
describe.each(HELPERS)('%s', (_name, rethrow) => {
  it.each(['accessDenied', 'ErrorAccessDenied', 'Authorization_RequestDenied', 'ACCESSDENIED'])(
    'reports 403 %s as a missing grant naming the code and the permissions',
    (code) => {
      const err = graph_error(403, code, 'Access is denied.');

      const failure = thrown_by(rethrow, err) as MissingGraphPermissionsError;

      expect(failure).toBeInstanceOf(MissingGraphPermissionsError);
      expect(failure).toBeInstanceOf(AuthError);
      expect(failure.code).toBe('ATLAS_AUTH_DENIED');
      expect(failure.message).toContain(`403 Forbidden (${code})`);
      expect(failure.message).toContain('Application permissions with admin consent');
      expect(failure.graph_code).toBe(code);
      expect(failure.status_code).toBe(403);
      expect(failure.permissions.length).toBeGreaterThan(0);
      expect(failure.cause).toBe(err);
    },
  );

  it('fails the request for a 403 whose code is not a missing grant, naming that code', () => {
    const err = graph_error(403, 'ErrorQuotaExceeded', 'The quota was exceeded.');

    const failure = thrown_by(rethrow, err) as Error & Record<string, unknown>;

    expect(failure).not.toBeInstanceOf(AuthError);
    expect(failure.message).toContain('403 ErrorQuotaExceeded');
    expect(failure.message).toContain('The quota was exceeded.');
    expect(failure.message).not.toContain('ErrorAccessDenied');
    expect(failure.message).not.toContain('admin consent');
    expect(failure).toMatchObject({ statusCode: 403, code: 'ErrorQuotaExceeded', cause: err });
  });

  it('fails the request for a 403 with no error code, and says it had none', () => {
    const err = Object.assign(new Error(''), { statusCode: 403 });

    const failure = thrown_by(rethrow, err) as Error & Record<string, unknown>;

    expect(failure).not.toBeInstanceOf(AuthError);
    expect(failure.message).toContain('403 with no error code');
    expect(failure).toMatchObject({ statusCode: 403, code: null, cause: err });
  });

  it('returns for a status other than 403', () => {
    expect(thrown_by(rethrow, graph_error(404, 'ErrorItemNotFound'))).toBeUndefined();
  });
});

describe('Teams Forbidden code', () => {
  // Teams answers a missing role permission and an unapproved protected API with `Forbidden`.
  it('is a missing grant on a Teams call', () => {
    const err = graph_error(403, 'Forbidden', 'Missing role permissions on the request.');

    const failure = thrown_by(rethrow_if_teams_access_denied, err);

    expect(failure).toBeInstanceOf(MissingGraphPermissionsError);
    expect((failure as Error).message).toContain('ChannelMessage.Read.All');
  });

  it('is a failed request on a mail call', () => {
    const failure = thrown_by(rethrow_if_access_denied, graph_error(403, 'Forbidden'));

    expect(failure).not.toBeInstanceOf(AuthError);
    expect((failure as Error).message).toContain('403 Forbidden, which does not name');
  });
});

describe('MailboxNotEnabledForRESTAPI on a 403', () => {
  it('is still a licence problem when the licence check runs first', () => {
    const err = graph_error(403, 'MailboxNotEnabledForRESTAPI');

    expect(thrown_by(rethrow_if_mailbox_not_licensed, err)).toBeInstanceOf(MailboxNotLicensedError);
  });
});

describe('is_missing_grant_refusal', () => {
  it.each([
    [graph_error(403, 'ErrorAccessDenied'), true],
    [graph_error(403, 'Authorization_RequestDenied'), true],
    [graph_error(403, 'ErrorQuotaExceeded'), false],
    [graph_error(403, 'Forbidden'), false],
    [graph_error(401, 'ErrorAccessDenied'), false],
    [null, false],
  ])('answers %o with %s', (err, expected) => {
    expect(is_missing_grant_refusal(err)).toBe(expected);
  });
});

describe('the permission names a missing grant carries', () => {
  it('are the names alone, without the guidance after them', () => {
    const failure = thrown_by(
      (err) => rethrow_if_access_denied(err, ['Calendars.Read']),
      graph_error(403, 'ErrorAccessDenied'),
    ) as MissingGraphPermissionsError;

    expect(failure.permissions).toEqual(['Calendars.Read']);
  });

  it('strip the description from the default mail list', () => {
    const failure = thrown_by(
      rethrow_if_access_denied,
      graph_error(403, 'ErrorAccessDenied'),
    ) as MissingGraphPermissionsError;

    expect(failure.permissions).toEqual([
      'Mail.Read',
      'Mail.ReadWrite',
      'User.Read.All',
      'MailboxSettings.Read',
    ]);
  });
});
