import { createHash, timingSafeEqual } from 'node:crypto';

/** Thrown when ciphertext decrypts but fails its AES-GCM authentication tag check. */
export class OneDriveDecryptAuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OneDriveDecryptAuthError';
  }
}

/** Returns whether an error represents an AES-GCM authentication failure. */
export function is_gcm_auth_failure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('Unsupported state') || message.toLowerCase().includes('auth');
}

/** Compares a plaintext buffer with its expected SHA-256 checksum. */
export function plaintext_sha256_equals_expected(content: Buffer, expected_hex: string): boolean {
  const actual_hex = createHash('sha256').update(content).digest('hex');
  if (actual_hex.length !== expected_hex.length) return false;
  return timingSafeEqual(Buffer.from(actual_hex, 'utf8'), Buffer.from(expected_hex, 'utf8'));
}
