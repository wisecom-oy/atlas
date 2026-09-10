import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';
import { WrongPassphraseError } from '@wisecom/atlas-types';
import { DEFAULT_KDF_STRATEGY, KDF_STRATEGIES } from '@/adapters/keystore/kdf-strategy';
import { parse_dek_blob, build_header_bytes } from '@/adapters/keystore/dek-blob-codec';
import type { DekBlobHeader } from '@/adapters/keystore/dek-blob-codec';
import {
  build_content_header,
  content_aad,
  content_scope,
  has_content_header,
  read_content_header,
  CONTENT_HEADER_LENGTH,
} from '@/adapters/keystore/content-envelope';

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
 * Content format: [magic] [version] [12-byte IV] [16-byte auth tag] [ciphertext], with the header
 * and the object's scope authenticated as AAD so a ciphertext only decrypts where it belongs
 * (issue #350). A blob written before that header existed has no AAD and is read as it always was.
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

  /**
   * Encrypts plaintext using the given DEK, bound to the object's storage key.
   *
   * The binding is the key's directory, so the result decrypts under that prefix and nowhere else.
   */
  encrypt(data: Buffer, dek: Buffer, storage_key: string): Buffer {
    const header = build_content_header();
    const aad = content_aad(header, content_scope(storage_key));
    return Buffer.concat([header, aes_gcm_encrypt(data, dek, aad)]);
  }

  /**
   * Decrypts ciphertext using the given DEK. Throws on tampered data, and on a blob that carries
   * the versioned header but was written for another scope.
   *
   * A blob with no header predates the binding and is decrypted without AAD.
   */
  decrypt(data: Buffer, dek: Buffer, storage_key: string): Buffer {
    if (!has_content_header(data)) return aes_gcm_decrypt(data, dek);
    const header = read_content_header(data);
    const aad = content_aad(header, content_scope(storage_key));
    return aes_gcm_decrypt(data.subarray(CONTENT_HEADER_LENGTH), dek, aad);
  }

  /**
   * Creates a streaming AES-256-GCM cipher bound to a scope, plus the header the caller has to
   * write ahead of the IV for the object to be readable.
   *
   * `scope_key` is any key in the directory the finished object will live in, which for the
   * large-file pipeline is the content-addressed key rather than the staging key it streams into.
   */
  create_encrypt_cipher(
    dek: Buffer,
    scope_key: string,
  ): { cipher: CipherGCM; iv: Buffer; header: Buffer } {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, dek, iv, { authTagLength: AUTH_TAG_LENGTH });
    const header = build_content_header();
    cipher.setAAD(content_aad(header, content_scope(scope_key)));
    return { cipher, iv, header };
  }

  /**
   * Creates a streaming AES-256-GCM decipher initialized with IV and auth tag.
   *
   * `header` is the envelope header the reader found ahead of the IV, or undefined for an object
   * written before the header existed, which authenticates without AAD.
   */
  create_decrypt_decipher(
    dek: Buffer,
    iv: Buffer,
    auth_tag: Buffer,
    scope_key: string,
    header?: Buffer,
  ): DecipherGCM {
    const decipher = createDecipheriv(ALGORITHM, dek, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(auth_tag);
    if (header) decipher.setAAD(content_aad(header, content_scope(scope_key)));
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
    try {
      return aes_gcm_decrypt(encrypted_dek, kek, header_bytes);
    } catch (err) {
      // GCM reports a wrong key and a corrupted blob as the same authentication failure, and the
      // raw Node message ("Unsupported state or unable to authenticate data") reads like data
      // loss. A wrong passphrase is by far the likelier cause and the only one the operator can
      // act on, so it is named first and the original error is kept as `cause` (issue #40).
      throw new WrongPassphraseError(
        'Could not unwrap the data key: the passphrase does not match the one this backup was ' +
          'written with, or the wrapped key is damaged. Check ATLAS_ENCRYPTION_PASSPHRASE ' +
          'against the tenant this snapshot belongs to.',
        { cause: err },
      );
    }
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
