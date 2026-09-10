import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  ConfigError,
  MailboxNotLicensedError,
  NotFoundError,
  ObjectLockRetainedError,
  StorageError,
  ThrottledError,
  WrongPassphraseError,
} from '@wisecom/atlas-types';
import { handle_fatal_error } from '@/fatal-error';

let previous_exit_code: typeof process.exitCode;
let diagnostics: string[];

beforeEach(() => {
  previous_exit_code = process.exitCode;
  process.exitCode = undefined;
  diagnostics = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    diagnostics.push(args.join(' '));
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  process.exitCode = previous_exit_code;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('fatal CLI errors', () => {
  it('keeps the wrong-passphrase code, crypto cause and recovery guidance on stderr', () => {
    const cause = Object.assign(new Error('Authentication tag mismatch'), {
      code: 'ERR_OSSL_BAD_DECRYPT',
    });
    handle_fatal_error(new WrongPassphraseError('Key could not be unwrapped', { cause }));

    expect(process.exitCode).toBe(5);
    const output = diagnostics.join('\n');
    expect(output).toContain('ATLAS_WRONG_PASSPHRASE');
    expect(output).toContain('ERR_OSSL_BAD_DECRYPT');
    expect(output).toContain(cause.message);
    expect(output).toMatch(/original.*passphrase/);
    expect(console.log).not.toHaveBeenCalled();
  });

  it('prints both Atlas and Graph codes, HTTP status and response body for a 403', () => {
    const cause = Object.assign(new Error('Permission denied'), {
      statusCode: 403,
      code: 'ErrorAccessDenied',
      body: { error: { code: 'ErrorAccessDenied' } },
    });
    handle_fatal_error(new AuthError('Consent required', { cause }));

    expect(process.exitCode).toBe(4);
    const output = diagnostics.join('\n');
    expect(output).toContain('Atlas code: ATLAS_AUTH_DENIED');
    expect(output).toContain('Transport code: ErrorAccessDenied');
    expect(output).toContain('HTTP status: 403');
    expect(output).toContain('Body:');
    expect(console.log).not.toHaveBeenCalled();
  });

  it('reports throttle exhaustion separately and preserves retry timing and the transport cause', () => {
    const cause = { statusCode: 429, code: 'TooManyRequests' };
    handle_fatal_error(new ThrottledError('Retry budget exhausted', 12000, { cause }));

    expect(process.exitCode).toBe(3);
    const output = diagnostics.join('\n');
    expect(output).toContain('ATLAS_THROTTLED');
    expect(output).toContain('TooManyRequests');
    expect(output).toContain('429');
    expect(output).toContain('12000');
  });

  it.each([
    [new ConfigError('Invalid configuration'), 6],
    [new MailboxNotLicensedError('License required'), 4],
    [new NotFoundError('Backup not found'), 7],
    [new ObjectLockRetainedError('object-example'), 8],
    [new StorageError('Storage failed'), 1],
  ])('gives %s its documented category', (error, code) => {
    handle_fatal_error(error);
    expect(process.exitCode).toBe(code);
    expect(diagnostics.join('\n')).toContain(error.code);
  });

  it('finds nested Node codes without guessing from message text or labelling Graph as S3', () => {
    const cause = Object.assign(new Error('Connection failed'), { code: 'ECONNRESET' });
    handle_fatal_error(new TypeError('Request failed', { cause }));
    expect(process.exitCode).toBe(3);
    expect(diagnostics.join('\n')).toContain('ECONNRESET');
    expect(diagnostics.join('\n')).not.toContain('S3');

    diagnostics = [];
    handle_fatal_error(new Error('ECONNRESET: socket hang up'));
    expect(process.exitCode).toBe(1);
  });

  it('recognizes a nested storage connection failure and preserves AWS error details', () => {
    const cause = Object.assign(new Error('Connection failed'), {
      code: 'ENOTFOUND',
      name: 'NetworkingError',
      $metadata: { attempts: 3 },
    });
    handle_fatal_error(new StorageError('Storage request failed', { cause }));
    expect(process.exitCode).toBe(3);
    expect(diagnostics.join('\n')).toContain('NetworkingError');
    expect(diagnostics.join('\n')).toContain('S3');
  });

  it.each([
    [{ statusCode: 403, code: 'ErrorAccessDenied' }, 4, 'ATLAS_AUTH_DENIED'],
    [{ statusCode: 429, code: 'TooManyRequests' }, 3, 'ATLAS_THROTTLED'],
    [{ name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }, 7, 'ATLAS_NOT_FOUND'],
  ])('classifies unwrapped provider failures by status, not prose', (error, code, atlas_code) => {
    handle_fatal_error(error);
    expect(process.exitCode).toBe(code);
    expect(diagnostics.join('\n')).toContain(atlas_code);
  });

  it('does not override an operator-action failure with a transient cause', () => {
    const cause = Object.assign(new Error('Connection failed'), { code: 'ETIMEDOUT' });
    handle_fatal_error(new ConfigError('Configuration unavailable', { cause }));
    expect(process.exitCode).toBe(6);
  });

  it('classifies AWS server errors as retryable without treating every 5xx as transient', () => {
    handle_fatal_error({ name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } });
    expect(process.exitCode).toBe(3);
    handle_fatal_error({ name: 'NotImplemented', $metadata: { httpStatusCode: 501 } });
    expect(process.exitCode).toBe(1);
  });

  it('reports unexpected values and cyclic diagnostic bodies without masking the failure', () => {
    handle_fatal_error(null);
    expect(process.exitCode).toBe(1);
    expect(diagnostics.join('\n')).toContain('null');

    const error = Object.assign(new Error('Unexpected failure'), {
      cause: {} as unknown,
      body: {},
    });
    error.cause = error;
    error.body = error;
    handle_fatal_error(error);
    expect(process.exitCode).toBe(1);
    expect(diagnostics.join('\n')).toContain('Unexpected failure');
  });

  it('keeps debug stacks on stderr rather than corrupting stdout', () => {
    vi.stubEnv('DEBUG', '1');
    const error = new Error('Unexpected failure');
    error.stack = 'Error: Unexpected failure\n    at example';
    handle_fatal_error(error);
    expect(diagnostics.join('\n')).toContain(error.stack);
    expect(console.log).not.toHaveBeenCalled();
  });
});
