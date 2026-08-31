import { describe, it, expect } from 'vitest';
import {
  classify_download_failure,
  read_graph_error_code,
  is_download_refused,
  is_missing_graph_permissions,
  is_unretryable_download_failure,
  DownloadRefusedError,
  MissingGraphPermissionsError,
} from '@/graph-download-classification';

/**
 * The shared classifier both drive download paths delegate to (issue #246). Keeping
 * it in one place is what stops the two drives drifting apart, so the assertions
 * here are the contract each drive relies on.
 */
describe('classify_download_failure', () => {
  describe('CDN errors, which carry status_code', () => {
    // A pre-authenticated URL that has expired is the one case where re-resolving
    // and retrying is the right response.
    it.each([401, 403])('reads status_code %i as an expired URL', (status) => {
      expect(classify_download_failure({ status_code: status })).toBe('expired_url');
    });

    it.each([404, 429, 500])('leaves status_code %i unclassified', (status) => {
      expect(classify_download_failure({ status_code: status })).toBe('unclassified');
    });
  });

  describe('Graph errors, which carry statusCode', () => {
    // 401 and 403 shared a branch before #246, which is why a credential problem and
    // a permissions problem both produced a URL refresh.
    it('reads 401 as unauthorized, never as an expired URL', () => {
      expect(classify_download_failure({ statusCode: 401 })).toBe('unauthorized');
    });

    it.each(['accessDenied', 'ErrorAccessDenied', 'ACCESSDENIED'])(
      'reads 403 with code %s as a missing permission',
      (code) => {
        expect(classify_download_failure({ statusCode: 403, code })).toBe('missing_permission');
      },
    );

    it.each(['notAllowed', 'malwareDetected', 'someFutureCode', ''])(
      'reads 403 with code %s as a service refusal',
      (code) => {
        expect(classify_download_failure({ statusCode: 403, code })).toBe('service_refused');
      },
    );

    // Conservative on purpose: an unrecognised 403 records one item rather than
    // aborting a whole tenant backup.
    it('reads a 403 with no code at all as a service refusal', () => {
      expect(classify_download_failure({ statusCode: 403 })).toBe('service_refused');
    });

    it.each([404, 429, 500])('leaves statusCode %i unclassified', (status) => {
      expect(classify_download_failure({ statusCode: status })).toBe('unclassified');
    });
  });

  describe('everything else', () => {
    // The substring test on Forbidden and Unauthorized is gone. Microsoft's error
    // guidance is that `message` can change at any time and only `code` should be
    // relied on, and the old test also matched wrapped storage and proxy errors.
    it.each(['Forbidden', 'Unauthorized', 'HTTP 403 Forbidden'])(
      'does not classify by message text: %s',
      (message) => {
        expect(classify_download_failure(new Error(message))).toBe('unclassified');
      },
    );

    // Previously a TypeError from reading .statusCode off the raw value (issue #263),
    // which replaced the real download failure on the way out of the catch block.
    it.each([undefined, null, 'string', 0, false])('classifies %s without throwing', (value) => {
      expect(classify_download_failure(value)).toBe('unclassified');
    });

    it('ignores a status carried as a string rather than a number', () => {
      expect(classify_download_failure({ statusCode: '403' })).toBe('unclassified');
      expect(classify_download_failure({ status_code: '403' })).toBe('unclassified');
    });
  });
});

describe('read_graph_error_code', () => {
  it('returns the code when present', () => {
    expect(read_graph_error_code({ code: 'notAllowed' })).toBe('notAllowed');
  });

  it.each([undefined, null, {}, { code: '' }, { code: 42 }])(
    'falls back to "unknown" for %s',
    (value) => {
      expect(read_graph_error_code(value)).toBe('unknown');
    },
  );
});

describe('error guards', () => {
  const refused = new DownloadRefusedError('refused', 'notAllowed');
  const missing = new MissingGraphPermissionsError('missing');

  it('identifies a refusal, which is permanent for the item but not the run', () => {
    expect(is_download_refused(refused)).toBe(true);
    expect(is_download_refused(missing)).toBe(false);
    expect(is_download_refused(new Error('other'))).toBe(false);
    expect(refused.graph_code).toBe('notAllowed');
    expect(refused.name).toBe('DownloadRefusedError');
  });

  it('identifies a missing grant, which must abort the run', () => {
    expect(is_missing_graph_permissions(missing)).toBe(true);
    expect(is_missing_graph_permissions(refused)).toBe(false);
    expect(missing.name).toBe('MissingGraphPermissionsError');
  });

  // The guard the download orchestrators use to decide what must not become a
  // silent per-file skip.
  it('treats both as unretryable and everything else as retryable', () => {
    expect(is_unretryable_download_failure(refused)).toBe(true);
    expect(is_unretryable_download_failure(missing)).toBe(true);
    expect(is_unretryable_download_failure(new Error('socket hang up'))).toBe(false);
    expect(is_unretryable_download_failure(undefined)).toBe(false);
  });
});
