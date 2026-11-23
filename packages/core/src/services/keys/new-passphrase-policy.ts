import { ConfigError } from '@wisecom/atlas-types';
import { is_acceptable_passphrase, MIN_PASSPHRASE_BYTES } from '@/services/keys/passphrase-floor';

/**
 * Rejects a new passphrase the SDK would refuse at construction.
 *
 * `createAtlasInstance` enforces the same floor, and `rewrapDataKey` reaches the wrap without
 * passing through it: an empty string would otherwise wrap the tenant key under an empty
 * passphrase, which is the one outcome this command must never produce.
 */
export function assert_usable_passphrase(passphrase: string): void {
  if (!is_acceptable_passphrase(passphrase)) {
    throw new ConfigError(
      `The new passphrase must contain at least ${MIN_PASSPHRASE_BYTES} UTF-8 bytes. ` +
        `Nothing was changed.`,
    );
  }
}
