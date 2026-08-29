import { describe, it, expect } from 'vitest';
import {
  build_upload_file_system_info,
  map_graph_file_system_info,
  map_graph_identity,
} from '@/graph-drive-metadata';

describe('map_graph_identity', () => {
  it('prefers the user, who is the answer to "who did this"', () => {
    const mapped = map_graph_identity({
      user: { displayName: 'Alice Andersson', email: 'alice@contoso.com', id: 'u-1' },
      application: { displayName: 'Some Workflow', id: 'app-1' },
    });

    expect(mapped).toEqual({
      display_name: 'Alice Andersson',
      email: 'alice@contoso.com',
      id: 'u-1',
    });
  });

  it('falls back to the application, which beats recording nothing', () => {
    const mapped = map_graph_identity({ application: { displayName: 'Retention Bot' } });

    expect(mapped).toEqual({ display_name: 'Retention Bot' });
  });

  it('returns undefined for an absent or empty identity set', () => {
    expect(map_graph_identity(undefined)).toBeUndefined();
    expect(map_graph_identity({})).toBeUndefined();
    // An identity object with no usable field must not become an empty author.
    expect(map_graph_identity({ user: {} })).toBeUndefined();
  });
});

describe('map_graph_file_system_info', () => {
  it('maps both client timestamps', () => {
    const mapped = map_graph_file_system_info({
      createdDateTime: '2019-03-04T10:00:00Z',
      lastModifiedDateTime: '2021-07-08T11:30:00Z',
    });

    expect(mapped).toEqual({
      created_at: '2019-03-04T10:00:00Z',
      last_modified_at: '2021-07-08T11:30:00Z',
    });
  });

  it('keeps a facet carrying only one timestamp', () => {
    expect(map_graph_file_system_info({ createdDateTime: '2019-03-04T10:00:00Z' })).toEqual({
      created_at: '2019-03-04T10:00:00Z',
    });
  });

  it('returns undefined rather than an empty object', () => {
    expect(map_graph_file_system_info(undefined)).toBeUndefined();
    expect(map_graph_file_system_info({})).toBeUndefined();
  });
});

describe('build_upload_file_system_info', () => {
  it('round-trips captured timestamps back into Graph shape', () => {
    const body = build_upload_file_system_info({
      created_at: '2019-03-04T10:00:00Z',
      last_modified_at: '2021-07-08T11:30:00Z',
    });

    expect(body).toEqual({
      createdDateTime: '2019-03-04T10:00:00Z',
      lastModifiedDateTime: '2021-07-08T11:30:00Z',
    });
  });

  it('returns undefined when nothing was captured, leaving the request unchanged', () => {
    // Pre-feature manifests carry no timestamps, and their uploads must look
    // exactly as they did before this existed.
    expect(build_upload_file_system_info(undefined)).toBeUndefined();
    expect(build_upload_file_system_info({})).toBeUndefined();
  });
});
