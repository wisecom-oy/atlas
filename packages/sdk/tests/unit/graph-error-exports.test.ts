import { describe, expect, it } from 'vitest';
import {
  AtlasError,
  AuthError,
  GraphAccessRefusedError,
  GraphUnavailableError,
  MissingGraphPermissionsError,
  isFileStorageContainerSite,
} from '@/index';

/** Issues #772 and #773: the Graph failures a consumer branches on are exported with their codes. */
describe('Graph error exports', () => {
  it('exports a missing grant as an AuthError with ATLAS_AUTH_DENIED', () => {
    const err = new MissingGraphPermissionsError('missing', { permissions: ['Sites.Read.All'] });
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe('ATLAS_AUTH_DENIED');
    expect(err.permissions).toEqual(['Sites.Read.All']);
  });

  it('exports a refused resource as an AtlasError that is not an AuthError', () => {
    const err = new GraphAccessRefusedError('refused', { site_id: 's' }, 'file_storage_container');
    expect(err).toBeInstanceOf(AtlasError);
    expect(err).not.toBeInstanceOf(AuthError);
    expect(err).toMatchObject({ code: 'ATLAS_ACCESS_REFUSED', site_id: 's' });
    expect(err.reason).toBe('file_storage_container');
  });

  it('exports an exhausted transient failure with ATLAS_GRAPH_UNAVAILABLE', () => {
    const err = new GraphUnavailableError('down', { retries: 12, elapsed_ms: 5 });
    expect(err).toMatchObject({ code: 'ATLAS_GRAPH_UNAVAILABLE', retries: 12, elapsed_ms: 5 });
  });
});

describe('isFileStorageContainerSite', () => {
  it('matches the rule listSites uses for kind', () => {
    expect(isFileStorageContainerSite('https://contoso.sharepoint.com/contentstorage/CSP_x')).toBe(
      true,
    );
    expect(isFileStorageContainerSite('https://contoso.sharepoint.com/sites/Engineering')).toBe(
      false,
    );
  });
});
