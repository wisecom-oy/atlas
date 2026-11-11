import { describe, it, expect } from 'vitest';
import { is_network_error } from '@/graph-network-error';

/** The shape the Graph SDK gives a native error it wraps: `name` copied into `code`, cause dropped. */
function sdk_wrapped(native: Error, status_code = -1): Error {
  return Object.assign(new Error(native.message), {
    statusCode: status_code,
    code: native.name,
    body: native.toString(),
  });
}

describe('is_network_error', () => {
  it.each([
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EPIPE',
    'EAI_AGAIN',
    'UND_ERR_SOCKET',
    'UND_ERR_BODY_TIMEOUT',
  ])('returns true for error code %s', (code) => {
    expect(is_network_error({ code })).toBe(true);
  });

  it('returns true for a raw fetch failure, from the socket error on its cause', () => {
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(is_network_error(new TypeError('fetch failed', { cause: reset }))).toBe(true);
  });

  it('returns true for a body cut off mid-read, two causes down', () => {
    const socket = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    const terminated = new TypeError('terminated', { cause: new Error('wrap', { cause: socket }) });
    expect(is_network_error(terminated)).toBe(true);
  });

  it('returns true for a fetch failure the Graph SDK wrapped and stripped of its cause', () => {
    expect(is_network_error(sdk_wrapped(new TypeError('fetch failed')))).toBe(true);
  });

  it('returns true for an aborted transfer, raw or wrapped by the SDK', () => {
    const aborted = new DOMException('This operation was aborted', 'AbortError');
    expect(is_network_error(aborted)).toBe(true);
    expect(is_network_error(sdk_wrapped(new DOMException('aborted', 'AbortError')))).toBe(true);
    expect(is_network_error(new DOMException('timed out', 'TimeoutError'))).toBe(true);
  });

  it('returns false for a 404 HTTP error', () => {
    expect(is_network_error({ statusCode: 404 })).toBe(false);
  });

  it('returns false for a business logic error', () => {
    expect(is_network_error(new Error('Mailbox not found'))).toBe(false);
  });

  it.each([
    'fetch failed while resolving the item',
    'Request was aborted by policy',
    'Session terminated by an administrator',
    'read ECONNRESET quoted in a Graph error message',
  ])('reads a Graph error code, never its message: "%s" (issue #618)', (message) => {
    const graph_error = Object.assign(new Error(message), {
      statusCode: 400,
      code: 'invalidRequest',
    });
    expect(is_network_error(graph_error)).toBe(false);
  });

  it('stops following a cause chain that loops', () => {
    const looped: { cause?: unknown } = {};
    looped.cause = looped;
    expect(is_network_error(looped)).toBe(false);
  });

  it('ignores non-object errors', () => {
    expect(is_network_error('socket hang up')).toBe(false);
    expect(is_network_error(undefined)).toBe(false);
  });
});
