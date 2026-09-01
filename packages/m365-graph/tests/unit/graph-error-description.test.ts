import { describe, it, expect } from 'vitest';
import { describe_graph_error, is_content_gone_error } from '@/graph-request-error-handler';

// Issue #92: Graph SDK errors routinely carry an empty `message` with the
// actionable part in `statusCode`/`code`, which produced blank log lines like
// "Version 1.0 of report.docx: ".

describe('describe_graph_error', () => {
  it('describes a Graph error whose message is empty', () => {
    const reason = describe_graph_error({ statusCode: 403, code: 'accessDenied', message: '' });

    expect(reason).toBe('HTTP 403 -- accessDenied');
  });

  it('joins status, code, and message when all are present', () => {
    const err = Object.assign(new Error('Access denied'), {
      statusCode: 403,
      code: 'accessDenied',
    });

    expect(describe_graph_error(err)).toBe('HTTP 403 -- accessDenied -- Access denied');
  });

  it('falls back to the response body when there is no message', () => {
    const reason = describe_graph_error({ body: '{"error":{"code":"resourceLocked"}}' });

    expect(reason).toContain('resourceLocked');
  });

  it('never returns an empty string for an error carrying nothing useful', () => {
    expect(describe_graph_error({})).not.toBe('');
    expect(describe_graph_error(new Error(''))).not.toBe('');
    expect(describe_graph_error(undefined)).toBe('unknown error');
  });

  it('caps long messages so one failure cannot flood the log', () => {
    const err = new Error('x'.repeat(500));

    expect(describe_graph_error(err).length).toBeLessThanOrEqual(200);
  });
});

describe('is_content_gone_error', () => {
  it.each([404, 410])('treats HTTP %i as gone', (status) => {
    expect(is_content_gone_error({ statusCode: status })).toBe(true);
    expect(is_content_gone_error({ status })).toBe(true);
  });

  it('does not treat a permission failure as gone', () => {
    expect(is_content_gone_error({ statusCode: 403, code: 'accessDenied', message: '' })).toBe(
      false,
    );
  });

  it('does not treat a throttle as gone', () => {
    expect(is_content_gone_error({ statusCode: 429 })).toBe(false);
  });

  it('ignores non-object errors', () => {
    expect(is_content_gone_error('boom')).toBe(false);
    expect(is_content_gone_error(undefined)).toBe(false);
  });
});
