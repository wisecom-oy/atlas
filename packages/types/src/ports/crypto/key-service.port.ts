export interface KeyService {
  /** Encrypts a data buffer and returns the ciphertext. */
  encrypt(data: Buffer): Promise<Buffer>;

  /** Decrypts a ciphertext buffer and returns the plaintext. */
  decrypt(data: Buffer): Promise<Buffer>;

  /** Generates a new data encryption key, returning both plain and encrypted forms. */
  generate_data_key(): Promise<{ plain: Buffer; encrypted: Buffer }>;
}
