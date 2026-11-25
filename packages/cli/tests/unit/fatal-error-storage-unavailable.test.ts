import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageError, StorageUnavailableError } from '@wisecom/atlas-types';
import { handle_fatal_error } from '@/fatal-error';

// Issue #924: a storage backend that never answered exits 3, the transient category.

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
});

/** The error the SDK's HTTP handler raises when a socket stays idle past its timeout. */
function idle_timeout(): Error {
  return Object.assign(new Error('the request socket timed out after 300000 ms of inactivity'), {
    name: 'TimeoutError',
    $metadata: { attempts: 3 },
  });
}

describe('fatal storage-unavailable errors', () => {
  it('exits 3 with ATLAS_STORAGE_UNAVAILABLE and names the timeout', () => {
    handle_fatal_error(
      new StorageUnavailableError('S3 HeadBucket got no answer after 3 attempt(s)', 3, {
        cause: idle_timeout(),
      }),
    );

    expect(process.exitCode).toBe(3);
    const output = diagnostics.join('\n');
    expect(output).toContain('Atlas code: ATLAS_STORAGE_UNAVAILABLE');
    expect(output).toContain('Error name: TimeoutError');
    expect(output).toContain('Cannot connect to S3');
  });

  it('exits 3 when a broad StorageError wraps the unavailable backend', () => {
    const unavailable = new StorageUnavailableError('no answer', 3, { cause: idle_timeout() });
    handle_fatal_error(new StorageError('Manifest write failed', { cause: unavailable }));

    expect(process.exitCode).toBe(3);
  });

  it('exits 3 for a raw SDK timeout that reached the CLI unwrapped', () => {
    handle_fatal_error(idle_timeout());

    expect(process.exitCode).toBe(3);
  });

  it('keeps exit 1 for a TimeoutError that came with an HTTP answer it does not classify', () => {
    const answered = Object.assign(idle_timeout(), { $metadata: { httpStatusCode: 400 } });
    handle_fatal_error(answered);

    expect(process.exitCode).toBe(1);
  });
});
