import { describe, it, expect } from 'vitest';
import {
  DEK_BLOB_VERSION,
  parse_dek_blob,
  serialize_dek_blob,
} from '@/adapters/keystore/dek-blob-codec';

describe('dek-blob-codec', () => {
  const params = Buffer.alloc(38);
  params.writeUInt32BE(65536, 0);
  const tail = Buffer.alloc(60);

  it('serialize and parse round-trip', () => {
    const blob = serialize_dek_blob({ kdf_id: 1, kdf_params: params }, tail);
    const { header, encrypted_dek } = parse_dek_blob(blob);
    expect(header.kdf_id).toBe(1);
    expect(header.kdf_params.equals(params)).toBe(true);
    expect(encrypted_dek.equals(tail)).toBe(true);
    expect(blob[0]).toBe(DEK_BLOB_VERSION);
    expect(blob[1]).toBe(1);
  });

  it('throws on unknown version', () => {
    const bad = Buffer.from([0xff, 1, 0, 38, ...params, ...tail]);
    expect(() => parse_dek_blob(bad)).toThrow('Unsupported wrapped DEK version');
  });

  it('throws when KDF params length exceeds buffer', () => {
    const buf = Buffer.from([DEK_BLOB_VERSION, 1, 0, 38]); // declares 38-byte params, buffer ends here
    expect(() => parse_dek_blob(buf)).toThrow('truncated');
  });

  it('throws when blob is too short for header', () => {
    expect(() => parse_dek_blob(Buffer.from([1]))).toThrow('too short');
  });
});
