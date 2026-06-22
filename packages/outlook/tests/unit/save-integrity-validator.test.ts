import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { compute_sha256, verify_checksum } from '@/services/save/save-integrity-validator';

describe('compute_sha256', () => {
  it('returns hex digest matching node crypto', () => {
    const data = Buffer.from('hello world');
    const expected = createHash('sha256').update(data).digest('hex');
    expect(compute_sha256(data)).toBe(expected);
  });

  it('returns different digest for different input', () => {
    const a = compute_sha256(Buffer.from('aaa'));
    const b = compute_sha256(Buffer.from('bbb'));
    expect(a).not.toBe(b);
  });

  it('handles empty buffer', () => {
    const result = compute_sha256(Buffer.alloc(0));
    expect(result).toHaveLength(64);
  });
});

describe('verify_checksum', () => {
  it('returns true when checksum matches', () => {
    const data = Buffer.from('test content');
    const checksum = createHash('sha256').update(data).digest('hex');
    expect(verify_checksum(data, checksum)).toBe(true);
  });

  it('returns false when checksum does not match', () => {
    const data = Buffer.from('test content');
    const wrong = 'a'.repeat(64);
    expect(verify_checksum(data, wrong)).toBe(false);
  });

  it('returns false when expected has different length', () => {
    const data = Buffer.from('test content');
    expect(verify_checksum(data, 'tooshort')).toBe(false);
  });
});
