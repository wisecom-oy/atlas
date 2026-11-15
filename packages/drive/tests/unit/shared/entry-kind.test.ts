import { describe, expect, it } from 'vitest';
import type { DriveManifestEntry } from '@/drive-ports';
import {
  count_file_entries,
  entry_kind,
  is_file_entry,
  records_file_content,
} from '@/shared/entry-kind';
import { restorable_entries, restorable_item_metadata_entries } from '@/shared/manifest-chain';
import { select_restore_entries } from '@/restore/restore-selection';
import { completed_recrawl } from '@/backup/recrawl-tombstones';

function entry(file_id: string, fields: Partial<DriveManifestEntry> = {}): DriveManifestEntry {
  return {
    file_id,
    drive_id: 'drive-1',
    file_name: `${file_id}.txt`,
    parent_path: '/',
    size_bytes: 1,
    storage_key: `data/${file_id}`,
    checksum: 'sha',
    backup_at: '2026-11-01T00:00:00Z',
    change_type: 'created',
    ...fields,
  };
}

/** An entry with no stored content, as a folder entry is written. */
function folder_entry(file_id: string): DriveManifestEntry {
  const { storage_key: _key, checksum: _checksum, ...rest } = entry(file_id, { kind: 'folder' });
  return rest;
}

/** An entry exactly as manifests written before #580 hold it: no kind, no permissions. */
const LEGACY_FILE = entry('legacy');
const FOLDER = folder_entry('fo');
const rows = (entries: DriveManifestEntry[]) =>
  entries.map((e) => ({ snapshot_id: 's', entry: e }));

describe('entry kinds (#580)', () => {
  it('reads an entry without a kind as a file, so older snapshots restore as before', () => {
    expect(entry_kind(LEGACY_FILE)).toBe('file');
    expect(is_file_entry(LEGACY_FILE)).toBe(true);
    expect(restorable_entries(rows([LEGACY_FILE]))).toEqual([LEGACY_FILE]);
  });

  it('keeps folder entries out of content, counts and version history', () => {
    const all = [LEGACY_FILE, FOLDER];
    expect(restorable_entries(rows(all))).toEqual([LEGACY_FILE]);
    expect(restorable_item_metadata_entries(rows(all))).toEqual([FOLDER]);
    expect(count_file_entries(all)).toBe(1);
    expect(all.filter(records_file_content)).toEqual([LEGACY_FILE]);
  });

  it('starts no version row for a sharing-only change', () => {
    expect(records_file_content(entry('p', { change_type: 'permissions_changed' }))).toBe(false);
  });

  it('leaves retired folder entries out of a restore', () => {
    const retired = { ...FOLDER, change_type: 'deleted' as const };
    expect(restorable_item_metadata_entries(rows([retired]))).toEqual([]);
  });

  it('selects folder entries by the file filter too, and leaves them out of a single-file rename', () => {
    const chain = rows([LEGACY_FILE, FOLDER]);
    expect(select_restore_entries(chain, ['/fo.txt'], undefined)).toMatchObject({
      files: [],
      item_metadata: [FOLDER],
    });
    expect(select_restore_entries(chain, undefined, 'renamed.txt')).toMatchObject({
      files: [LEGACY_FILE],
      item_metadata: [],
    });
  });
});

describe('completed_recrawl with a full enumeration (#580)', () => {
  it('treats a fresh listing after a pre-sharing cursor as a re-crawl', () => {
    const delta = { items: [{ item_id: 'a' }], reset_detected: false, full_enumeration: true };
    expect(completed_recrawl('drive-1', delta, 'old-link', false)?.returned_item_ids).toEqual(
      new Set(['a']),
    );
  });

  it('does not for an ordinary incremental delta', () => {
    const delta = { items: [{ item_id: 'a' }], reset_detected: false };
    expect(completed_recrawl('drive-1', delta, 'link', false)).toBeUndefined();
  });
});
