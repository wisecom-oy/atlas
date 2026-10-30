import { describe, expect, it, vi } from 'vitest';
import type { MailboxConnector } from '@wisecom/atlas-types/ports/mail/connector.port';
import { RateLimitedGraphConnector } from '@/rate-limited-graph-connector.adapter';
import { InProcessThrottleCoordinator } from '@wisecom/atlas-core/services/shared/in-process-throttle-coordinator';
import { DefaultMailboxRateLimiterFactory } from '@wisecom/atlas-core/services/shared/mailbox-rate-limiter';
import { logger } from '@wisecom/atlas-core/utils/logger';

function wrap(inner: MailboxConnector): RateLimitedGraphConnector {
  const throttle = new InProcessThrottleCoordinator();
  return new RateLimitedGraphConnector(
    inner,
    new DefaultMailboxRateLimiterFactory(throttle),
    throttle,
  );
}

/**
 * Issue #455. The decorator's `list_mail_folders` took two parameters, which still satisfies the
 * port, so TypeScript accepted it while it dropped every folder option on the way to Graph:
 * `--include-recoverable-items` captured nothing, `--exclude-junk` kept Junk Email, and pruned
 * folders were never recorded in `excluded_folders`.
 */
describe('RateLimitedGraphConnector.list_mail_folders', () => {
  it('forwards the folder options to the inner connector unchanged', async () => {
    const list_mail_folders = vi.fn(async () => []);
    const connector = wrap({ list_mail_folders } as unknown as MailboxConnector);
    const options = { exclude_junk: true, include_recoverable_items: true, on_excluded: vi.fn() };

    await connector.list_mail_folders('t', 'o', options);

    expect(list_mail_folders).toHaveBeenCalledWith('t', 'o', options);
    connector.shutdown();
  });
});

/**
 * Issue #513. A connector that cannot read reactions used to drop them without a word, so a
 * misconfigured connector looked like a mailbox nobody reacts in.
 */
describe('RateLimitedGraphConnector.fetch_reaction_properties', () => {
  it('says once that reactions are not captured when the inner connector cannot read them', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const connector = wrap({} as MailboxConnector);

    await expect(connector.fetch_reaction_properties('t', 'o', ['m1'])).resolves.toBeUndefined();
    await connector.fetch_reaction_properties('t', 'o', ['m2']);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reactions'));
    warn.mockRestore();
    connector.shutdown();
  });
});
