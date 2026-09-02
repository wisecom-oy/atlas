import { describe, it, expect } from 'vitest';
import {
  DRIVE_DELTA_SELECT_FIELDS,
  map_delta_item,
  type GraphDeltaDriveItem,
} from '@/adapters/graph-onedrive-delta-mapper';

// Issue #139: driveItem delta signals removal with the `deleted` facet. The
// `@removed` annotation belongs to messages/delta and never appears here, and
// the facet is stripped unless $select asks for it.

const DRIVE_ID = 'd1';

describe('DRIVE_DELTA_SELECT_FIELDS', () => {
  it('requests the deleted facet, without which removals are invisible', () => {
    expect(DRIVE_DELTA_SELECT_FIELDS.split(',')).toContain('deleted');
  });
});

describe('map_delta_item deletion detection', () => {
  it('treats the deleted facet as a removal', () => {
    const raw: GraphDeltaDriveItem = {
      id: 'i1',
      parentReference: { path: '/drive/root:/Folder' },
      file: {},
      size: 1024,
      deleted: { state: 'deleted' },
    };

    const item = map_delta_item(raw, DRIVE_ID);

    expect(item.deleted).toBe(true);
    expect(item.kind).toBe('file');
    expect(item.item_id).toBe('i1');
  });

  it('still honours the @removed annotation', () => {
    const item = map_delta_item(
      { id: 'i2', file: {}, '@removed': { reason: 'deleted' } },
      DRIVE_ID,
    );

    expect(item.deleted).toBe(true);
  });

  it('maps a removed item that Graph returns without name or downloadUrl', () => {
    // Exactly what Graph sends: no name, no size, no download URL.
    const item = map_delta_item(
      {
        id: 'i3',
        parentReference: { path: '/drive/root:/Folder' },
        file: {},
        deleted: { state: 'deleted' },
      },
      DRIVE_ID,
    );

    expect(item.deleted).toBe(true);
    expect(item.file_name).toBe('');
    expect(item.download_url).toBeUndefined();
    expect(item.parent_path).toBe('/Folder');
  });

  it('leaves a live item undeleted', () => {
    const item = map_delta_item(
      {
        id: 'i4',
        name: 'Report.docx',
        file: {},
        size: 10,
        parentReference: { path: '/drive/root:/' },
        '@microsoft.graph.downloadUrl': 'https://example.invalid/content',
      },
      DRIVE_ID,
    );

    expect(item.deleted).toBe(false);
    expect(item.file_name).toBe('Report.docx');
    expect(item.download_url).toBe('https://example.invalid/content');
  });

  it('classifies a removed folder as a folder, not a file', () => {
    const item = map_delta_item({ id: 'i5', folder: {}, deleted: { state: 'deleted' } }, DRIVE_ID);

    expect(item.deleted).toBe(true);
    expect(item.kind).toBe('folder');
  });

  it('detects a removal from its shape when a legacy delta link omits the facet', () => {
    // A saved deltaLink pins the $select it was created with, so cursors written
    // before `deleted` joined the field list answer without it. Graph still
    // sends no name for a removed item.
    const item = map_delta_item(
      { id: 'i6', parentReference: { path: '/drive/root:/Folder' }, file: {}, size: 2048 },
      DRIVE_ID,
    );

    expect(item.deleted).toBe(true);
  });

  it('does not mistake the drive root for a removal', () => {
    const item = map_delta_item({ id: 'root-id', name: 'root', folder: {} }, DRIVE_ID);

    expect(item.deleted).toBe(false);
  });
});
