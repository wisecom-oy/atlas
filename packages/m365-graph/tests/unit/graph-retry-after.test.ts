import { describe, expect, it } from 'vitest';
import { parse_retry_after_ms } from '@/graph-retry-after';

/**
 * Issue #203: `parseInt` on an HTTP-date returns NaN, so a server that answered with the date form
 * of `Retry-After` had its instruction thrown away and got exponential backoff instead.
 */
const NOW = Date.parse('2026-08-26T10:00:00.000Z');

describe('parse_retry_after_ms', () => {
  describe('delta-seconds form', () => {
    it('converts seconds to milliseconds', () => {
      expect(parse_retry_after_ms('120', NOW)).toBe(120_000);
    });

    it('tolerates surrounding whitespace', () => {
      expect(parse_retry_after_ms('  30  ', NOW)).toBe(30_000);
    });

    it('accepts zero as an immediate retry', () => {
      expect(parse_retry_after_ms('0', NOW)).toBe(0);
    });

    it('never lets a numeric value reach Date.parse', () => {
      // Date.parse('120') is the year 120, which would resolve to a wait of about -1.9 million
      // years. The digit test has to come first for that reason.
      expect(parse_retry_after_ms('120', NOW)).toBeGreaterThan(0);
    });
  });

  describe('HTTP-date form', () => {
    it('returns the remaining wait for an IMF-fixdate', () => {
      expect(parse_retry_after_ms('Wed, 26 Aug 2026 10:02:00 GMT', NOW)).toBe(120_000);
    });

    it('accepts the obsolete RFC 850 form', () => {
      expect(parse_retry_after_ms('Wednesday, 26-Aug-26 10:02:00 GMT', NOW)).toBe(120_000);
    });

    it('returns undefined for a past date rather than a negative delay', () => {
      // Zero would suppress the caller's backoff and jitter, so "no instruction" is the safer
      // answer than "retry immediately".
      expect(parse_retry_after_ms('Wed, 26 Aug 2026 09:58:00 GMT', NOW)).toBeUndefined();
    });

    it('caps an implausibly distant date', () => {
      const one_hour = 60 * 60 * 1000;
      expect(parse_retry_after_ms('Wed, 26 Aug 2099 10:00:00 GMT', NOW)).toBe(one_hour);
    });
  });

  describe('values carrying no instruction', () => {
    it.each([null, undefined, '', '   ', 'not-a-date', 'soon', 'Infinity'])(
      'returns undefined for %p',
      (value) => {
        expect(parse_retry_after_ms(value, NOW)).toBeUndefined();
      },
    );

    it('returns undefined for a negative seconds value', () => {
      // '-5' fails the digit test and Date.parse reads it as a date in 2001, which is in the past.
      expect(parse_retry_after_ms('-5', NOW)).toBeUndefined();
    });

    it('never returns NaN', () => {
      for (const value of ['abc', '12abc', '-', '+', 'NaN']) {
        const parsed = parse_retry_after_ms(value, NOW);
        expect(parsed === undefined || Number.isFinite(parsed)).toBe(true);
      }
    });
  });
});
