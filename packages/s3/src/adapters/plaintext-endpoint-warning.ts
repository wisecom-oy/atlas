import { isIP } from 'node:net';
import { logger } from '@wisecom/atlas-core/utils/logger';

// ponytail: process-wide set; one warning per endpoint per process is what "once per run" means here.
const warned = new Set<string>();

/**
 * Warns once per endpoint when S3 traffic would cross a network in clear (issue #448).
 *
 * Content stays AES-256-GCM ciphertext and SigV4 never sends the secret key, but object keys,
 * the access key id and the request pattern are readable, and a forged `200` to a `PutObject`
 * goes unnoticed until the next verify. Loopback is exempt: it is the local MinIO setup.
 */
export function warn_if_plaintext_endpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return; // ponytail: a malformed endpoint fails on first use with the SDK's own error.
  }
  if (url.protocol !== 'http:' || is_loopback(url.hostname) || warned.has(url.host)) return;
  warned.add(url.host);
  logger.warn(
    `S3 endpoint ${url.host} uses plain HTTP. Stored content stays encrypted, but object keys ` +
      `(including mailbox addresses), the access key id and the backup schedule are readable ` +
      `on the network, and a forged upload response would go unnoticed until the next verify. ` +
      `Use https:// for any endpoint that is not on this machine.`,
  );
}

function is_loopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isIP(host) === 4) return host.startsWith('127.');
  return host === '::1';
}
