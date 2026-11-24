import { describe, expect, it } from 'vitest';
import { is_file_storage_container_site } from '@wisecom/atlas-types/domain/sharepoint/site-kind';
import * as contract from '@/contract';
import * as sdk from '@/index';

describe('contract isFileStorageContainerSite', () => {
  it.each([
    'https://contoso.sharepoint.com/contentstorage/CSP_00000000-0000-0000-0000-000000000000',
    'https://contoso.sharepoint.com/ContentStorage/CSP_x/',
  ])('flags the SharePoint Embedded container %s', (url) => {
    expect(contract.isFileStorageContainerSite(url)).toBe(true);
  });

  it.each([
    'https://contoso.sharepoint.com/sites/Engineering',
    'https://contoso.sharepoint.com/sites/contentstorage',
    'not a url',
    '',
  ])('passes %j as an ordinary site', (url) => {
    expect(contract.isFileStorageContainerSite(url)).toBe(false);
  });

  it('is the classifier Atlas site discovery uses', () => {
    expect(contract.isFileStorageContainerSite).toBe(is_file_storage_container_site);
  });

  it('keeps its main entry export, as the same binding', () => {
    expect(sdk.isFileStorageContainerSite).toBe(contract.isFileStorageContainerSite);
  });
});
