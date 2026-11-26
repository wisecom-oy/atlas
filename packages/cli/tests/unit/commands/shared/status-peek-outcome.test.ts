import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphUnavailableError, ThrottledError } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core';
import { describe_peek_error } from '@wisecom/atlas-core/services/shared/status-peek-error';
import { failed_peek_exit_code, report_failed_peeks } from '@/commands/shared/status-peek-outcome';

const THROTTLED = describe_peek_error(new ThrottledError('retry budget exhausted'));
const UNAVAILABLE = describe_peek_error(
  new GraphUnavailableError('Graph kept answering 503', { retries: 12, elapsed_ms: 60_000 }),
);
const OTHER = describe_peek_error(new Error('delta resync failed'));

/** Issue #870: a status run whose peeks failed exits non-zero instead of 0. */
describe('failed_peek_exit_code', () => {
  it('is undefined when no peek failed', () => {
    expect(failed_peek_exit_code([])).toBeUndefined();
  });

  it('is 3 when every failure was a throttle or an unavailable Graph', () => {
    expect(failed_peek_exit_code([THROTTLED, UNAVAILABLE])).toBe(3);
  });

  it('is 2 when any failure was something else', () => {
    expect(failed_peek_exit_code([THROTTLED, OTHER])).toBe(2);
    expect(failed_peek_exit_code([OTHER])).toBe(2);
  });

  it('matches the class name only, not a class named inside the message', () => {
    expect(failed_peek_exit_code(['Error: wrapped ThrottledError: retry budget exhausted'])).toBe(
      2,
    );
  });
});

describe('report_failed_peeks', () => {
  let previous: typeof process.exitCode;
  let errors: string[];

  beforeEach(() => {
    previous = process.exitCode;
    process.exitCode = undefined;
    errors = [];
    vi.spyOn(logger, 'error').mockImplementation((message: string) => {
      errors.push(message);
    });
  });

  afterEach(() => {
    process.exitCode = previous;
    vi.restoreAllMocks();
  });

  it('leaves a run whose peeks all succeeded alone', () => {
    report_failed_peeks([{}, { peek_error: undefined }], 'Folder');

    expect(process.exitCode).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('names the count and the exit code it sets', () => {
    report_failed_peeks([{ peek_error: THROTTLED }, {}], 'Drive');

    expect(process.exitCode).toBe(3);
    expect(errors).toEqual(['Drive(s) not checked: 1 -- exit 3']);
  });

  it('keeps the exit code an earlier finding chose, and does not claim its own', () => {
    process.exitCode = 9;

    report_failed_peeks([{ peek_error: OTHER }], 'Library');

    expect(process.exitCode).toBe(9);
    expect(errors).toEqual(['Library(s) not checked: 1']);
  });
});
