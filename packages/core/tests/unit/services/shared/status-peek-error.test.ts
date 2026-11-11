import { describe, expect, it } from 'vitest';
import { AuthError, MailboxNotLicensedError, NotFoundError } from '@wisecom/atlas-types';
import { describe_peek_error, rethrow_if_peek_fatal } from '@/services/shared/status-peek-error';

const with_status = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), { statusCode: status });

describe('rethrow_if_peek_fatal', () => {
  it('rethrows AuthError and MailboxNotLicensedError as they are', () => {
    const auth = new AuthError('denied');
    const unlicensed = new MailboxNotLicensedError('unlicensed');

    expect(() => rethrow_if_peek_fatal(auth)).toThrow(auth);
    expect(() => rethrow_if_peek_fatal(unlicensed)).toThrow(unlicensed);
  });

  it.each([401, 403])('wraps a bare Graph %i in an AuthError carrying the cause', (status) => {
    const raw = with_status(status);
    let thrown: unknown;
    try {
      rethrow_if_peek_fatal(raw);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(AuthError);
    expect((thrown as AuthError).cause).toBe(raw);
  });

  it.each([
    ['a 503', with_status(503)],
    ['a NotFoundError', new NotFoundError('folder gone')],
    ['a network error', new Error('ECONNRESET')],
    ['a non-error value', 'boom'],
  ])('lets %s through for the row to record', (_label, err) => {
    expect(() => rethrow_if_peek_fatal(err)).not.toThrow();
  });
});

describe('describe_peek_error', () => {
  it('names the error class', () => {
    expect(describe_peek_error(new NotFoundError('folder gone'))).toBe(
      'NotFoundError: folder gone',
    );
    expect(describe_peek_error('boom')).toBe('Error: boom');
  });
});
