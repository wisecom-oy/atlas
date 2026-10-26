import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { warn_if_plaintext_endpoint } from '@/adapters/plaintext-endpoint-warning';

/** Issue #448. The warned set is process-wide, so each case uses its own host. */
describe('warn_if_plaintext_endpoint', () => {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  afterEach(() => warn.mockClear());

  it('warns once for a remote plain-HTTP endpoint, naming the exposure', () => {
    warn_if_plaintext_endpoint('http://offsite:9000');
    warn_if_plaintext_endpoint('http://offsite:9000/');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('object keys');
  });

  it.each([
    'http://localhost:9000',
    'http://minio.localhost:9000',
    'http://127.0.0.1:9000',
    'http://127.1.2.3:9000',
    'http://[::1]:9000',
  ])('stays quiet for loopback %s', (endpoint) => {
    warn_if_plaintext_endpoint(endpoint);

    expect(warn).not.toHaveBeenCalled();
  });

  it('stays quiet for https', () => {
    warn_if_plaintext_endpoint('https://s3.example.com');

    expect(warn).not.toHaveBeenCalled();
  });

  it('does not treat a lookalike host as loopback', () => {
    warn_if_plaintext_endpoint('http://localhost.example.com:9000');
    warn_if_plaintext_endpoint('http://127.0.0.1.example.com:9000');

    expect(warn).toHaveBeenCalledTimes(2);
  });
});
