import {
  scryptSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  type CipherGCM,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

/**
 * Envelope encryption using AES-256-GCM.
 *
 * - A master passphrase + tenant_id derive a unique KEK per tenant (scrypt).
 * - A random DEK is generated per tenant, encrypted ("wrapped") with the KEK.
 * - All tenant data is encrypted with the DEK.
 *
 * Encrypted format: [12-byte IV] [16-byte auth tag] [ciphertext]
 */
export class EnvelopeKeyService {
  private readonly _kek: Buffer;

  constructor(passphrase: string, tenant_id: string) {
    this._kek = derive_kek(passphrase, tenant_id);
  }

  /** Encrypts plaintext using the given DEK. */
  encrypt(data: Buffer, dek: Buffer): Buffer {
    return aes_gcm_encrypt(data, dek);
  }

  /** Decrypts ciphertext using the given DEK. Throws on tampered data. */
  decrypt(data: Buffer, dek: Buffer): Buffer {
    return aes_gcm_decrypt(data, dek);
  }

  /**
   * Creates a streaming AES-256-GCM cipher using the DEK (same parameters as
   * {@link EnvelopeKeyService.encrypt}); finalize with auth tag for the envelope format.
   */
  create_encrypt_cipher(dek: Buffer): { cipher: CipherGCM; iv: Buffer } {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, dek, iv, { authTagLength: AUTH_TAG_LENGTH });
    return { cipher, iv };
  }

  /** Generates a fresh random 256-bit DEK. */
  generate_dek(): Buffer {
    return randomBytes(KEY_LENGTH);
  }

  /** Encrypts (wraps) a DEK with this tenant's KEK. */
  wrap_dek(dek: Buffer): Buffer {
    return aes_gcm_encrypt(dek, this._kek);
  }

  /** Decrypts (unwraps) a wrapped DEK with this tenant's KEK. */
  unwrap_dek(wrapped: Buffer): Buffer {
    return aes_gcm_decrypt(wrapped, this._kek);
  }
}

/**
 * Derives a 256-bit key encryption key from a passphrase and tenant_id salt
 * using scrypt (N=65536, r=8, p=1).
 */
export function derive_kek(passphrase: string, tenant_id: string): Buffer {
  return scryptSync(passphrase, tenant_id, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
}

/** AES-256-GCM encrypt. Returns: [IV (12)] [auth tag (16)] [ciphertext]. */
function aes_gcm_encrypt(plaintext: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

/** AES-256-GCM decrypt. Expects format: [IV (12)] [auth tag (16)] [ciphertext]. */
function aes_gcm_decrypt(blob: Buffer, key: Buffer): Buffer {
  if (blob.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Ciphertext too short to contain IV and auth tag');
  }

  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
