import { describe, it, expect, vi } from 'vitest';
import { is_permanent_item_error } from '@/graph-permanent-item-errors';
import { is_transient_error, with_graph_retry } from '@/graph-request-error-handler';

/**
 * Issue #812. Exchange answers `$value` for some items with a 500 that never changes, so retrying
 * it spent the whole budget on every run.
 */

function conversion_failed(): Record<string, unknown> {
  return {
    statusCode: 500,
    code: 'ErrorMimeContentConversionFailed',
    message: 'MIME content conversion failed.',
  };
}

describe('is_permanent_item_error', () => {
  it('matches ErrorMimeContentConversionFailed whatever its case', () => {
    expect(is_permanent_item_error(conversion_failed())).toBe(true);
    expect(
      is_permanent_item_error({ statusCode: 500, code: 'errormimecontentconversionfailed' }),
    ).toBe(true);
  });

  it.each([
    ['a plain 500', { statusCode: 500, code: 'InternalServerError' }],
    ['a 500 without a code', { statusCode: 500 }],
    ['a non-object', 'ErrorMimeContentConversionFailed'],
    ['null', null],
  ])('does not match %s', (_label, err) => {
    expect(is_permanent_item_error(err)).toBe(false);
  });
});

describe('is_transient_error with a permanent item code', () => {
  it('treats the 500 as final', () => {
    expect(is_transient_error(conversion_failed())).toBe(false);
  });

  it('keeps other 500s transient', () => {
    expect(is_transient_error({ statusCode: 500, code: 'InternalServerError' })).toBe(true);
  });
});

describe('with_graph_retry with a permanent item code', () => {
  it('throws on the first attempt instead of retrying', async () => {
    const failure = conversion_failed();
    const fn = vi.fn().mockRejectedValue(failure);

    await expect(with_graph_retry(fn)).rejects.toBe(failure);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
