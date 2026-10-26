import { describe, expect, it, vi } from 'vitest';
import type { MailboxConnector } from '@wisecom/atlas-types/ports/mail/connector.port';
import { RateLimitedGraphConnector } from '@/rate-limited-graph-connector.adapter';
import { ThrottleFence } from '@wisecom/atlas-core/services/shared/throttle-fence';
import { DefaultMailboxRateLimiterFactory } from '@wisecom/atlas-core/services/shared/mailbox-rate-limiter';

/**
 * Issue #455. The decorator's `list_mail_folders` took two parameters, which still satisfies the
 * port, so TypeScript accepted it while it dropped every folder option on the way to Graph:
 * `--include-recoverable-items` captured nothing, `--exclude-junk` kept Junk Email, and pruned
 * folders were never recorded in `excluded_folders`.
 */
describe('RateLimitedGraphConnector.list_mail_folders', () => {
  it('forwards the folder options to the inner connector unchanged', async () => {
    const list_mail_folders = vi.fn(async () => []);
    const inner = { list_mail_folders } as unknown as MailboxConnector;
    const fence = new ThrottleFence();
    const connector = new RateLimitedGraphConnector(
      inner,
      new DefaultMailboxRateLimiterFactory(fence),
      fence,
    );
    const options = { exclude_junk: true, include_recoverable_items: true, on_excluded: vi.fn() };

    await connector.list_mail_folders('t', 'o', options);

    expect(list_mail_folders).toHaveBeenCalledWith('t', 'o', options);
    connector.shutdown();
  });
});
