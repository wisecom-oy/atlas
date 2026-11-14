import { ConfigError } from '@wisecom/atlas-types';
import { MIN_PASSPHRASE_BYTES } from '@/adapters/keystore/kdf-strategy';

/**
 * Rejects a new passphrase the SDK would refuse at construction.
 *
 * `createAtlasInstance` enforces 14 UTF-8 bytes, and `rewrapDataKey` reaches the wrap without
 * passing through it: an empty string would otherwise wrap the tenant key under an empty
 * passphrase, which is the one outcome this command must never produce.
 */
export function assert_usable_passphrase(passphrase: string): void {
  if (Buffer.byteLength(passphrase, 'utf8') < MIN_PASSPHRASE_BYTES) {
    throw new ConfigError(
      `The new passphrase must contain at least ${MIN_PASSPHRASE_BYTES} UTF-8 bytes. ` +
        `Nothing was changed.`,
    );
  }
}
