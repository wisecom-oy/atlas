import { describe, it, expect, vi } from 'vitest';
import type { SharePointDeltaItem, SharePointSiteConnector } from '@wisecom/atlas-types';
import {
  make_connector,
  make_cursors,
  make_file_indexes,
  make_file_item,
  make_manifests,
  make_service,
} from './sharepoint-backup-determinism.fixtures';

const NOTEBOOK_PATH = '/Docs/Team Notebook';

function make_notebook_root(): SharePointDeltaItem {
  return make_file_item('nb-1', {
    kind: 'folder',
    file_name: 'Team Notebook',
    parent_path: '/Docs',
    package_type: 'oneNote',
    size_bytes: 0,
  });
}

function make_section(id: string, name: string): SharePointDeltaItem {
  return make_file_item(id, { file_name: name, parent_path: NOTEBOOK_PATH });
}

function connector_with(
  items: SharePointDeltaItem[],
  failing_item_id?: string,
): SharePointSiteConnector {
  return make_connector({
    fetch_delta: vi.fn().mockResolvedValue({
      drive_id: 'drive-1',
      delta_link: 'https://delta-link',
      items,
      reset_detected: false,
    }),
    // A failed download rejects; the port never resolves to undefined, and the
    // download orchestrator is what turns the rejection into a failed item.
    download_file_content: vi.fn((item: SharePointDeltaItem) =>
      item.item_id === failing_item_id
        ? Promise.reject(new Error('download failed'))
        : Promise.resolve(Buffer.from(item.item_id)),
    ),
  });
}

async function run_backup(items: SharePointDeltaItem[], failing_item_id?: string) {
  const service = make_service({
    connector: connector_with(items, failing_item_id),
    manifests: make_manifests(),
    file_indexes: make_file_indexes(),
    cursors: make_cursors(),
  });
  return service.backup_site('tenant-1', 'site-1');
}

describe('SharePoint backup — OneNote package accounting', () => {
  it('reports a detected notebook and its section files in the run warnings', async () => {
    const result = await run_backup([
      make_notebook_root(),
      make_section('sec-a', 'Section A.one'),
      make_section('sec-b', 'Section B.one'),
    ]);

    expect(result.summary.warnings).toContain(
      'OneNote notebooks detected: 1 (2 section file(s) backed up as ordinary files).',
    );
    expect(result.summary.healthy).toBe(true);
  });

  it('warns that a notebook is INCOMPLETE when one section file fails to download', async () => {
    const result = await run_backup(
      [
        make_notebook_root(),
        make_section('sec-a', 'Section A.one'),
        make_section('sec-b', 'Section B.one'),
      ],
      'sec-b',
    );

    const incomplete = result.summary.warnings.filter((w) => w.includes('INCOMPLETE'));
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toContain('Team Notebook');
    expect(incomplete[0]).toContain(NOTEBOOK_PATH);
    expect(incomplete[0]).toContain('Section B.one');
    expect(incomplete[0]).toContain('1 of 2 section file(s) failed');
    expect(result.summary.healthy).toBe(false);
  });

  it('adds no notebook lines when the delta batch holds no package items', async () => {
    const result = await run_backup([make_file_item('plain-1'), make_file_item('plain-2')]);

    expect(result.summary.warnings.filter((w) => w.includes('OneNote'))).toEqual([]);
    expect(result.summary.healthy).toBe(true);
  });
});
