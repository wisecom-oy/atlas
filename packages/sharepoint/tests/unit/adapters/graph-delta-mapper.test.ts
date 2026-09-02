import { describe, it, expect } from 'vitest';
import { map_delta_item, type GraphDeltaDriveItem } from '@/adapters/graph-sharepoint-delta-mapper';

// Issue #139: driveItem delta signals removal with the `deleted` facet, not the
// `@removed` annotation used by messages/delta.

const DRIVE_ID = 'lib1';

describe('map_delta_item deletion detection', () => {
  it('treats the deleted facet as a removal', () => {
    const raw: GraphDeltaDriveItem = {
      id: 'i1',
      parentReference: { path: '/drives/lib1/root:/Shared Documents' },
      file: {},
      deleted: { state: 'deleted' },
    };

    const item = map_delta_item(raw, DRIVE_ID);

    expect(item.deleted).toBe(true);
    expect(item.kind).toBe('file');
    expect(item.parent_path).toBe('/Shared Documents');
  });

  it('still honours the @removed annotation', () => {
    const item = map_delta_item(
      { id: 'i2', file: {}, '@removed': { reason: 'deleted' } },
      DRIVE_ID,
    );

    expect(item.deleted).toBe(true);
  });

  it('maps a removed item that Graph returns without name or downloadUrl', () => {
    const item = map_delta_item({ id: 'i3', file: {}, deleted: { state: 'deleted' } }, DRIVE_ID);

    expect(item.deleted).toBe(true);
    expect(item.file_name).toBe('');
    expect(item.download_url).toBeUndefined();
  });

  it('leaves a live item undeleted', () => {
    const item = map_delta_item(
      {
        id: 'i4',
        name: 'Budget.xlsx',
        file: {},
        size: 20,
        '@microsoft.graph.downloadUrl': 'https://example.invalid/content',
      },
      DRIVE_ID,
    );

    expect(item.deleted).toBe(false);
    expect(item.file_name).toBe('Budget.xlsx');
  });

  it('detects a removal from its shape when a legacy delta link omits the facet', () => {
    // A saved deltaLink pins its original $select, so older cursors answer
    // without the `deleted` facet; a nameless item is a removed one.
    const item = map_delta_item({ id: 'i5', file: {}, size: 4096 }, DRIVE_ID);

    expect(item.deleted).toBe(true);
  });

  it('does not mistake the library root for a removal', () => {
    const item = map_delta_item({ id: 'root-id', name: 'root', folder: {} }, DRIVE_ID);

    expect(item.deleted).toBe(false);
  });
});
