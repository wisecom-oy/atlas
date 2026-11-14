/**
 * The local identity key and the digests derived from it.
 *
 * `identity_key` and `url_key` in the journal are HMAC-SHA256 digests under a
 * key that lives only in this checkout (`.outagesoft-365/identity.key`). That
 * makes them comparable between runs here, which replay and `compare` need,
 * while staying meaningless anywhere else: without the key, a journal line
 * cannot be tested against a guessed URL or mailbox address.
 *
 * The key is not a credential, but it is the one thing that turns the digests
 * back into a dictionary attack target, so it is created 0600 and never copied
 * into a run directory.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEY_BYTES = 32;

/**
 * Creates the key atomically: the bytes go to a private temp file, which is
 * then hard-linked into place. A link either appears complete or fails with
 * EEXIST, so a concurrent reader never sees a half-written key, and the loser
 * of a race simply reads the winner's key.
 */
function create_key_atomically(key_path) {
  const temp = `${key_path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, randomBytes(KEY_BYTES), { flag: 'wx', mode: 0o600 });
  try {
    linkSync(temp, key_path);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    unlinkSync(temp);
  }
}

/** Reads the identity key under `home_dir`, creating it on first use. */
export function load_or_create_identity_key(home_dir) {
  const key_path = join(home_dir, 'identity.key');
  mkdirSync(home_dir, { recursive: true, mode: 0o700 });
  if (!existsSync(key_path)) create_key_atomically(key_path);
  const key = readFileSync(key_path);
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${key_path} is not a ${KEY_BYTES}-byte key; delete it to have a new one created`,
    );
  }
  return key;
}

/** First 16 hex characters of HMAC-SHA256(key, text). */
export function keyed_digest(key, text) {
  return createHmac('sha256', key).update(text).digest('hex').slice(0, 16);
}
