/**
 * Minimum passphrase length, in UTF-8 bytes, for wrapping a tenant key. The wrapped key sits in the
 * bucket with its KDF parameters in the clear, so bucket read access allows offline guessing and
 * the passphrase is the whole defence (issue #447). Every wrap path and config check reads this.
 *
 * This module imports nothing: the SDK publishes it through `@wisecom/atlas-sdk/contract`, which
 * must bundle for a browser or a Worker (issue #824).
 */
export const MIN_PASSPHRASE_BYTES = 14;

const utf8_encoder = new TextEncoder();

/**
 * Counts a passphrase in UTF-8 bytes, the unit the floor is stated in. `TextEncoder` rather than
 * `Buffer` so the count is the same in Node, a browser, and a Worker; both encode a lone surrogate
 * as the three-byte replacement character.
 */
export function passphrase_byte_length(passphrase: string): number {
  return utf8_encoder.encode(passphrase).length;
}

/** True when the passphrase meets the floor Atlas enforces before wrapping a tenant key. */
export function is_acceptable_passphrase(passphrase: string): boolean {
  return passphrase_byte_length(passphrase) >= MIN_PASSPHRASE_BYTES;
}
