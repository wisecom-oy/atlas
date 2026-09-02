import { describe, it, expect } from 'vitest';
import { AuthError, MailboxNotLicensedError } from '@wisecom/atlas-types';
import {
  rethrow_if_access_denied,
  rethrow_if_mailbox_not_licensed,
} from '@/graph-permission-errors';

describe('rethrow_if_mailbox_not_licensed', () => {
  it('throws with actionable message when error code is MailboxNotEnabledForRESTAPI', () => {
    const err = { code: 'MailboxNotEnabledForRESTAPI', statusCode: 403, message: '' };

    expect(() => rethrow_if_mailbox_not_licensed(err)).toThrow('not licensed for API access');
  });

  // Issue #40: the guidance text is for the operator, the class and code are for the caller.
  it('throws a MailboxNotLicensedError carrying the code and the original error', () => {
    const err = { code: 'MailboxNotEnabledForRESTAPI', statusCode: 403, message: '' };

    const failure = (() => {
      try {
        rethrow_if_mailbox_not_licensed(err);
        return undefined;
      } catch (caught) {
        return caught as MailboxNotLicensedError;
      }
    })();

    expect(failure).toBeInstanceOf(MailboxNotLicensedError);
    expect(failure?.code).toBe('ATLAS_MAILBOX_NOT_LICENSED');
    expect(failure?.cause).toBe(err);
  });

  it('throws when MailboxNotEnabledForRESTAPI appears in error message', () => {
    const err = new Error('The mailbox is not enabled (MailboxNotEnabledForRESTAPI)');

    expect(() => rethrow_if_mailbox_not_licensed(err)).toThrow(
      'Reassign an Exchange Online license',
    );
  });

  it('does not throw for unrelated errors', () => {
    const err = { code: 'ErrorItemNotFound', statusCode: 404, message: 'Not found' };

    expect(() => rethrow_if_mailbox_not_licensed(err)).not.toThrow();
  });

  it('does not throw for access denied errors (handled separately)', () => {
    const err = { code: 'ErrorAccessDenied', statusCode: 403, message: 'Forbidden' };

    expect(() => rethrow_if_mailbox_not_licensed(err)).not.toThrow();
  });
});

describe('rethrow_if_access_denied', () => {
  it('throws an AuthError distinguishable from an unlicensed mailbox', () => {
    const failure = (() => {
      try {
        rethrow_if_access_denied({ statusCode: 403 });
        return undefined;
      } catch (caught) {
        return caught as AuthError;
      }
    })();

    expect(failure).toBeInstanceOf(AuthError);
    expect(failure).not.toBeInstanceOf(MailboxNotLicensedError);
    expect(failure?.code).toBe('ATLAS_AUTH_DENIED');
  });

  it('throws with permission guidance on 403', () => {
    const err = { statusCode: 403 };

    expect(() => rethrow_if_access_denied(err)).toThrow('403 Forbidden');
  });

  it('does not throw for non-403 errors', () => {
    const err = { statusCode: 404 };

    expect(() => rethrow_if_access_denied(err)).not.toThrow();
  });
});

describe('non-object throwables', () => {
  // Both helpers run inside `catch` blocks and must fall through for anything they do not
  // recognise. A rejected promise can carry `null`, and reading a field off it would replace the
  // real failure with a TypeError.
  it.each([[null], [undefined], ['a string'], [42]])('falls through for %s', (value) => {
    expect(() => rethrow_if_access_denied(value)).not.toThrow();
    expect(() => rethrow_if_mailbox_not_licensed(value)).not.toThrow();
  });

  it('still recognises the licensing failure in a bare string', () => {
    expect(() => rethrow_if_mailbox_not_licensed('MailboxNotEnabledForRESTAPI')).toThrow(
      MailboxNotLicensedError,
    );
  });
});
