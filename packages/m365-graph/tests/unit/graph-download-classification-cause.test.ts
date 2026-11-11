import { describe, expect, it } from 'vitest';
import { classify_download_failure, read_graph_error_code } from '@/graph-download-classification';
import { sleep } from '@/graph-attempt-cancellation';

/**
 * A chunk that fails for good is rethrown with the attempt's error as `cause` (issue #632). The
 * classifier follows that chain to the first error carrying a status, so wrapping an error no
 * longer hides why it failed.
 */
describe('classify_download_failure through cause', () => {
  it('classifies a wrapped CDN 403 as an expired URL', () => {
    const wrapped = new Error('Failed chunk 1/2', { cause: { status_code: 403 } });
    expect(classify_download_failure(wrapped)).toBe('expired_url');
  });

  it('classifies a wrapped Graph refusal and reads its code', () => {
    const wrapped = new Error('Failed chunk 1/2', {
      cause: { statusCode: 403, code: 'notAllowed' },
    });
    expect(classify_download_failure(wrapped)).toBe('service_refused');
    expect(read_graph_error_code(wrapped)).toBe('notAllowed');
  });

  it('prefers the outer status over a cause', () => {
    const outer = Object.assign(new Error('outer', { cause: { statusCode: 403 } }), {
      status_code: 500,
    });
    expect(classify_download_failure(outer)).toBe('unclassified');
  });

  it('stays unclassified, and terminates, on a cyclic cause chain', () => {
    const a: { cause?: unknown } = {};
    const b = { cause: a };
    a.cause = b;
    expect(classify_download_failure(a)).toBe('unclassified');
    expect(read_graph_error_code(a)).toBe('unknown');
  });
});

describe('sleep', () => {
  it('rejects at once for a signal that already fired', async () => {
    const reason = new Error('Run interrupted by Ctrl+C');
    const started = Date.now();
    await expect(sleep(60_000, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
