import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';
import { DEFAULT_KDF_STRATEGY, KDF_STRATEGIES } from '@/adapters/keystore/kdf-strategy';
import { parse_dek_blob, build_header_bytes } from '@/adapters/keystore/dek-blob-codec';
import type { DekBlobHeader } from '@/adapters/keystore/dek-blob-codec';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * Envelope encryption using AES-256-GCM.
 *
 * - A master passphrase derives a KEK per wrap via a registered KDF strategy
 *   (scrypt v1, OWASP N=65536, per-wrap random salt, tenant-domain separation).
 * - A random DEK is generated per tenant and wrapped with the KEK into a
 *   versioned, AAD-authenticated blob (see `dek-blob-codec`).
 * - All tenant data is encrypted with the DEK (buffer or streaming).
 *
 * Content format: [12-byte IV] [16-byte auth tag] [ciphertext]
 */
export class EnvelopeKeyService {
  // Stored as a Buffer so it can be zeroed via destroy(). The caller-side JS
  // string is unavoidable in Node.js but is short-lived (scoped to construction).
  private _passphrase_buf: Buffer;

  constructor(passphrase: string) {
    this._passphrase_buf = Buffer.from(passphrase, 'utf-8');
  }

  /** Zeros the passphrase buffer. Call after the DEK has been loaded/created. */
  destroy(): void {
    this._passphrase_buf.fill(0);
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

  /** Creates a streaming AES-256-GCM decipher initialized with IV and auth tag. */
  create_decrypt_decipher(dek: Buffer, iv: Buffer, auth_tag: Buffer): DecipherGCM {
    const decipher = createDecipheriv(ALGORITHM, dek, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(auth_tag);
    return decipher;
  }

  /** Generates a fresh random 256-bit DEK. */
  generate_dek(): Buffer {
    return randomBytes(KEY_LENGTH);
  }

  /**
   * Encrypts (wraps) a DEK with a KEK derived from the passphrase, tenant_id,
   * and a per-wrap random salt. The versioned header is authenticated as AAD,
   * so version/KDF/params cannot be tampered with or downgraded.
   */
  wrap_dek(dek: Buffer, tenant_id: string): Buffer {
    const strategy = DEFAULT_KDF_STRATEGY;
    const params = strategy.generate_params(this._passphrase_buf.length);
    const header: DekBlobHeader = { kdf_id: strategy.kdf_id, kdf_params: params };
    const header_bytes = build_header_bytes(header);
    const kek = strategy.derive_kek(this._passphrase_buf, params, tenant_id);
    const encrypted = aes_gcm_encrypt(dek, kek, header_bytes);
    return Buffer.concat([header_bytes, encrypted]);
  }

  /** Decrypts (unwraps) a wrapped DEK using the passphrase, tenant_id, and blob metadata. */
  unwrap_dek(wrapped: Buffer, tenant_id: string): Buffer {
    const { header, header_bytes, encrypted_dek } = parse_dek_blob(wrapped);
    const strategy = KDF_STRATEGIES.get(header.kdf_id);
    if (!strategy) {
      throw new Error(`Unknown KDF id in wrapped DEK: ${header.kdf_id}`);
    }
    const kek = strategy.derive_kek(this._passphrase_buf, header.kdf_params, tenant_id);
    return aes_gcm_decrypt(encrypted_dek, kek, header_bytes);
  }
}

/** AES-256-GCM encrypt. Returns: [IV (12)] [auth tag (16)] [ciphertext]. */
function aes_gcm_encrypt(plaintext: Buffer, key: Buffer, aad?: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  if (aad) cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

/** AES-256-GCM decrypt. Expects format: [IV (12)] [auth tag (16)] [ciphertext]. */
function aes_gcm_decrypt(blob: Buffer, key: Buffer, aad?: Buffer): Buffer {
  if (blob.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Ciphertext too short to contain IV and auth tag');
  }

  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(aad);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
