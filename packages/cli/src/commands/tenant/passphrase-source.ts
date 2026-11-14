import { find_config_file, read_secure_config, update_secure_config } from '@wisecom/atlas-core';

/**
 * Where the passphrase in use came from, in `load_config` precedence: the environment (or a
 * `.env` file, which dotenv loads into it) wins over the encrypted store, which wins over the
 * plain config file.
 */
export type PassphraseSource =
  | { readonly kind: 'environment'; readonly store_also_holds_one: boolean }
  | { readonly kind: 'secure_store' }
  | { readonly kind: 'config_file'; readonly path: string | undefined };

/** Finds which source supplied the configured passphrase. */
export function detect_passphrase_source(): PassphraseSource {
  const store_holds_one = typeof read_secure_config().encryption_passphrase === 'string';
  if (process.env['ATLAS_ENCRYPTION_PASSPHRASE']) {
    return { kind: 'environment', store_also_holds_one: store_holds_one };
  }
  if (store_holds_one) return { kind: 'secure_store' };
  return { kind: 'config_file', path: find_config_file() };
}

/**
 * Writes the new passphrase into the encrypted config store, then reads it back.
 *
 * @throws Error when the read-back value is not the one written.
 */
export function store_new_passphrase(new_passphrase: string): void {
  update_secure_config((current) => ({ ...current, encryption_passphrase: new_passphrase }));
  if (read_secure_config().encryption_passphrase !== new_passphrase) {
    throw new Error(
      'The encrypted config store did not keep the new passphrase. Every key is already ' +
        'wrapped under it: set it with `atlas config set encryption.passphrase` now.',
    );
  }
}

/** Tells the operator exactly where to change a passphrase Atlas does not own. */
export function describe_manual_passphrase_change(source: PassphraseSource): string {
  if (source.kind === 'environment') {
    const store_note = source.store_also_holds_one
      ? ' The encrypted config store also holds the old one, which applies whenever the ' +
        'variable is unset: replace it with `atlas config set encryption.passphrase` too.'
      : '';
    return (
      'The passphrase comes from ATLAS_ENCRYPTION_PASSPHRASE, so Atlas changed nothing. Set ' +
      'that variable to the new passphrase wherever it is defined: the shell profile, a .env ' +
      'file, the scheduler, or the secrets manager.' +
      store_note
    );
  }
  const where = source.kind === 'config_file' && source.path ? source.path : 'atlas.config.json';
  return (
    `The passphrase comes from ${where}, so Atlas changed nothing. Replace its ` +
    '"encryption_passphrase" value with the new passphrase, or remove it and run ' +
    '`atlas config set encryption.passphrase` to keep it in the encrypted store instead.'
  );
}
