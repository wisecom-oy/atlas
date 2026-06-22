import { describe, it, expect } from 'vitest';
import { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';
import { KDF_SCRYPT } from '@/adapters/keystore/kdf-strategy';
import { DEK_BLOB_VERSION, parse_dek_blob } from '@/adapters/keystore/dek-blob-codec';

describe('EnvelopeKeyService', () => {
  const passphrase = 'test-passphrase';
  const tenant_id = 'tenant-1';

  describe('encrypt / decrypt round-trip', () => {
    it('round-trips arbitrary data', () => {
      const svc = new EnvelopeKeyService(passphrase);
      const dek = svc.generate_dek();
      const plaintext = Buffer.from('hello world, this is a test message');

      const ciphertext = svc.encrypt(plaintext, dek);
      const decrypted = svc.decrypt(ciphertext, dek);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('produces different ciphertext each time (random IV)', () => {
      const svc = new EnvelopeKeyService(passphrase);
      const dek = svc.generate_dek();
      const plaintext = Buffer.from('same data');

      const ct1 = svc.encrypt(plaintext, dek);
      const ct2 = svc.encrypt(plaintext, dek);
      expect(ct1.equals(ct2)).toBe(false);
    });

    it('ciphertext is longer than plaintext (IV + auth tag)', () => {
      const svc = new EnvelopeKeyService(passphrase);
      const dek = svc.generate_dek();
      const plaintext = Buffer.from('test');

      const ciphertext = svc.encrypt(plaintext, dek);
      expect(ciphertext.length).toBe(plaintext.length + 12 + 16);
    });

    it('rejects tampered ciphertext', () => {
      const svc = new EnvelopeKeyService(passphrase);
      const dek = svc.generate_dek();
      const ciphertext = svc.encrypt(Buffer.from('data'), dek);

      ciphertext[ciphertext.length - 1] ^= 0xff;
      expect(() => svc.decrypt(ciphertext, dek)).toThrow();
    });

    it('rejects truncated ciphertext', () => {
      const svc = new EnvelopeKeyService(passphrase);
      const dek = svc.generate_dek();
      const short = Buffer.alloc(10);

      expect(() => svc.decrypt(short, dek)).toThrow('too short');
    });
  });

  describe('wrap / unwrap DEK', () => {
    it('round-trips a DEK through wrap and unwrap', () => {
      const svc = new EnvelopeKeyService(passphrase);
      const dek = svc.generate_dek();

      const wrapped = svc.wrap_dek(dek, tenant_id);
      const unwrapped = svc.unwrap_dek(wrapped, tenant_id);
      expect(unwrapped.equals(dek)).toBe(true);
    });

    it('produces v1 blob with version and scrypt kdf id', () => {
      const svc = new EnvelopeKeyService(passphrase);
      const wrapped = svc.wrap_dek(svc.generate_dek(), tenant_id);
      expect(wrapped[0]).toBe(DEK_BLOB_VERSION);
      expect(wrapped[1]).toBe(KDF_SCRYPT);
    });

    it('wrapped blob is 102 bytes for a 256-bit DEK', () => {
      const svc = new EnvelopeKeyService(passphrase);
      const wrapped = svc.wrap_dek(svc.generate_dek(), tenant_id);
      expect(wrapped.length).toBe(102);
    });

    it('uses different salts on successive wraps', () => {
      const svc = new EnvelopeKeyService(passphrase);
      const dek = svc.generate_dek();
      const w1 = svc.wrap_dek(dek, tenant_id);
      const w2 = svc.wrap_dek(dek, tenant_id);
      const p1 = parse_dek_blob(w1).header.kdf_params.subarray(6);
      const p2 = parse_dek_blob(w2).header.kdf_params.subarray(6);
      expect(p1.equals(p2)).toBe(false);
    });

    it('wrapped DEK does not contain the plaintext DEK', () => {
      const svc = new EnvelopeKeyService(passphrase);
      const dek = svc.generate_dek();
      const wrapped = svc.wrap_dek(dek, tenant_id);

      expect(wrapped.includes(dek)).toBe(false);
    });

    it('cannot unwrap with wrong passphrase', () => {
      const svc_a = new EnvelopeKeyService(passphrase);
      const svc_b = new EnvelopeKeyService('other-passphrase');
      const dek = svc_a.generate_dek();

      const wrapped = svc_a.wrap_dek(dek, tenant_id);
      expect(() => svc_b.unwrap_dek(wrapped, tenant_id)).toThrow();
    });

    it('throws on unknown KDF id in blob', () => {
      const svc = new EnvelopeKeyService(passphrase);
      const wrapped = svc.wrap_dek(svc.generate_dek(), tenant_id);
      wrapped[1] = 0xff;
      expect(() => svc.unwrap_dek(wrapped, tenant_id)).toThrow('Unknown KDF id');
    });

    it('rejects tampered blob header (AAD protects header)', () => {
      const svc = new EnvelopeKeyService(passphrase);
      const dek = svc.generate_dek();
      const wrapped = svc.wrap_dek(dek, tenant_id);

      const { header } = parse_dek_blob(wrapped);
      header.kdf_params[0] ^= 0x01;
      expect(() => svc.unwrap_dek(wrapped, tenant_id)).toThrow();
    });

    it('cannot unwrap with wrong tenant_id (cross-tenant isolation)', () => {
      const svc = new EnvelopeKeyService(passphrase);
      const dek = svc.generate_dek();
      const wrapped = svc.wrap_dek(dek, 'tenant-a');

      expect(() => svc.unwrap_dek(wrapped, 'tenant-b')).toThrow();
    });
  });

  describe('destroy', () => {
    it('zeros the passphrase buffer', () => {
      const svc = new EnvelopeKeyService(passphrase);
      const dek = svc.generate_dek();
      const wrapped = svc.wrap_dek(dek, tenant_id);

      svc.destroy();
      expect(() => svc.unwrap_dek(wrapped, tenant_id)).toThrow();
    });
  });

  describe('generate_dek', () => {
    it('produces a 32-byte key', () => {
      const svc = new EnvelopeKeyService(passphrase);
      expect(svc.generate_dek().length).toBe(32);
    });

    it('produces unique keys', () => {
      const svc = new EnvelopeKeyService(passphrase);
      const k1 = svc.generate_dek();
      const k2 = svc.generate_dek();
      expect(k1.equals(k2)).toBe(false);
    });
  });
});
