/** Outer blob format version (v1: versioned header + AES-GCM-wrapped DEK tail). */
export const DEK_BLOB_VERSION = 0x01;

const VERSION_OFFSET = 0;
const KDF_ID_OFFSET = 1;
const PARAMS_LEN_OFFSET = 2;
const HEADER_PREFIX_LEN = 4;

export interface DekBlobHeader {
  readonly kdf_id: number;
  readonly kdf_params: Buffer;
}

/** Builds the binary header prefix: `[version][kdf_id][params_len BE][params]`. */
export function build_header_bytes(header: DekBlobHeader): Buffer {
  const params_len = header.kdf_params.length;
  if (params_len > 0xffff) {
    throw new Error('KDF params block too large');
  }
  const len_buf = Buffer.alloc(2);
  len_buf.writeUInt16BE(params_len, 0);
  return Buffer.concat([
    Buffer.from([DEK_BLOB_VERSION, header.kdf_id]),
    len_buf,
    header.kdf_params,
  ]);
}

/**
 * Serializes `[version][kdf_id][params_len BE][params][encrypted_dek]`.
 * `encrypted_dek` is typically `[IV][tag][ciphertext]` from AES-256-GCM.
 */
export function serialize_dek_blob(header: DekBlobHeader, encrypted_dek: Buffer): Buffer {
  return Buffer.concat([build_header_bytes(header), encrypted_dek]);
}

export interface ParsedDekBlob {
  readonly header: DekBlobHeader;
  readonly header_bytes: Buffer;
  readonly encrypted_dek: Buffer;
}

/** Parses a v1 blob. Throws if version is not `DEK_BLOB_VERSION` or the buffer is truncated. */
export function parse_dek_blob(blob: Buffer): ParsedDekBlob {
  if (blob.length < HEADER_PREFIX_LEN) {
    throw new Error('Wrapped DEK blob too short');
  }
  if (blob[VERSION_OFFSET] !== DEK_BLOB_VERSION) {
    throw new Error(
      `Unsupported wrapped DEK version: ${blob[VERSION_OFFSET]} (expected ${DEK_BLOB_VERSION})`,
    );
  }
  const kdf_id = blob.readUInt8(KDF_ID_OFFSET);
  const params_len = blob.readUInt16BE(PARAMS_LEN_OFFSET);
  const params_end = HEADER_PREFIX_LEN + params_len;
  if (blob.length < params_end) {
    throw new Error('Wrapped DEK blob truncated (KDF params)');
  }
  const kdf_params = blob.subarray(HEADER_PREFIX_LEN, params_end);
  const encrypted_dek = blob.subarray(params_end);
  return {
    header: { kdf_id, kdf_params },
    header_bytes: blob.subarray(0, params_end),
    encrypted_dek,
  };
}
