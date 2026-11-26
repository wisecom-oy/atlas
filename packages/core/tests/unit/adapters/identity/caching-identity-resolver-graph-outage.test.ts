import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphUnavailableError, ThrottledError } from '@wisecom/atlas-types';
import {
  capture_warnings,
  graph_error,
  KNOWN_ADDRESS,
  resolver_with_graph,
  STORED_JOHN,
  TENANT,
} from './identity-fallback-rig';

/**
 * Issue #882: an exhausted retry budget on the owner lookup fell back to the registry, so a backup
 * went on to spend a second full budget on the same outage while it held the owner's lease. The
 * fallback was logged at debug level, and the CLI then printed `Resolved` as if Graph had answered.
 */
const OUTAGE = new GraphUnavailableError('Microsoft Graph was unavailable after 12 retries', {
  retries: 12,
  elapsed_ms: 1_411_000,
});
const THROTTLED = new ThrottledError('Microsoft Graph kept throttling', 30_000);

describe('CachingIdentityResolver, a lookup for a command that works on live data', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['GraphUnavailableError', OUTAGE],
    ['ThrottledError', THROTTLED],
  ])('ends on an exhausted budget (%s) instead of using the registry', async (_name, outage) => {
    const resolver = resolver_with_graph(() => Promise.reject(outage));

    await expect(resolver.resolve_user(TENANT, KNOWN_ADDRESS)).rejects.toBe(outage);
    await expect(
      resolver.resolve_user(TENANT, KNOWN_ADDRESS, { purpose: 'microsoft_365' }),
    ).rejects.toBe(outage);
  });

  it('still uses the registry entry for a user Graph answers 404 for, and says so', async () => {
    const warnings = capture_warnings();
    const resolver = resolver_with_graph(() => Promise.reject(graph_error(404)));

    await expect(resolver.resolve_user(TENANT, KNOWN_ADDRESS)).resolves.toEqual(STORED_JOHN);

    expect(warnings.join('\n')).toContain(
      `Using the identity registry entry ${STORED_JOHN.object_id}`,
    );
    expect(warnings.join('\n')).toContain('HTTP 404');
  });

  it('still uses the registry entry after a 403, as before', async () => {
    capture_warnings();
    const resolver = resolver_with_graph(() => Promise.reject(graph_error(403)));

    await expect(resolver.resolve_user(TENANT, KNOWN_ADDRESS)).resolves.toEqual(STORED_JOHN);
  });

  it('rethrows an outage for an address the registry does not know, after one budget', async () => {
    const lookup = vi.fn(() => Promise.reject(OUTAGE));
    const resolver = resolver_with_graph(lookup);

    await expect(resolver.resolve_user(TENANT, 'jane.roe@example.com')).rejects.toBe(OUTAGE);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

describe('CachingIdentityResolver, a lookup for a command that reads stored backups', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the registry entry when Graph is down, and says so at the default log level', async () => {
    const warnings = capture_warnings();
    const resolver = resolver_with_graph(() => Promise.reject(OUTAGE));

    await expect(
      resolver.resolve_user(TENANT, KNOWN_ADDRESS, { purpose: 'stored_backups' }),
    ).resolves.toEqual(STORED_JOHN);

    expect(warnings.join('\n')).toContain(`Microsoft Graph did not resolve ${KNOWN_ADDRESS}`);
    expect(warnings.join('\n')).toContain(OUTAGE.message);
  });

  it('still reports an unknown address Graph answers 404 for as not found', async () => {
    const resolver = resolver_with_graph(() => Promise.reject(graph_error(404)));

    await expect(
      resolver.resolve_user(TENANT, 'jane.roe@example.com', { purpose: 'stored_backups' }),
    ).rejects.toThrow('Cannot resolve "jane.roe@example.com"');
  });
});
