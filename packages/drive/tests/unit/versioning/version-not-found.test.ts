import { describe, expect, it, vi } from 'vitest';
import type { DriveContentConnector, DriveDeltaItem, DriveFileVersion } from '@/drive-ports';
import { create_version_relisting, judge_version_not_found } from '@/versioning/version-not-found';

// Issue #855: a 404 on the content of a version the run had just listed was counted as expired.

const ITEM = {
  item_id: 'item-1',
  drive_id: 'drive-1',
  file_name: 'Report.docx',
} as DriveDeltaItem;

const V1: DriveFileVersion = {
  version_id: '1.0',
  last_modified_at: '2026-01-01T00:00:00Z',
  size_bytes: 10,
};

const T0 = new Date('2026-03-01T00:00:00Z');
const HOUR_MS = 60 * 60 * 1000;

function connector_listing(...answers: Array<DriveFileVersion[] | Error>): DriveContentConnector {
  const list_file_versions = vi.fn();
  for (const answer of answers) {
    if (answer instanceof Error) list_file_versions.mockRejectedValueOnce(answer);
    else list_file_versions.mockResolvedValueOnce(answer);
  }
  return { list_file_versions } as unknown as DriveContentConnector;
}

describe('judge_version_not_found', () => {
  it('counts a version that has left the list as gone', async () => {
    const relisting = create_version_relisting(connector_listing([]), ITEM);

    await expect(judge_version_not_found(relisting, ITEM, V1, undefined, T0)).resolves.toEqual({
      kind: 'gone',
    });
  });

  it('keeps a version that is still listed unconfirmed, starting its streak', async () => {
    const relisting = create_version_relisting(connector_listing([V1]), ITEM);

    await expect(judge_version_not_found(relisting, ITEM, V1, undefined, T0)).resolves.toEqual({
      kind: 'unconfirmed',
      streak: { reads: 1, since: T0.toISOString() },
    });
  });

  it('does not confirm on the read count alone while the window has not elapsed', async () => {
    const relisting = create_version_relisting(connector_listing([V1]), ITEM);
    const previous = { reads: 5, since: T0.toISOString() };
    const now = new Date(T0.getTime() + 2 * HOUR_MS);

    await expect(judge_version_not_found(relisting, ITEM, V1, previous, now)).resolves.toEqual({
      kind: 'unconfirmed',
      streak: { reads: 6, since: T0.toISOString() },
    });
  });

  it('accepts a still-listed version as gone after 3 runs spanning 24 hours', async () => {
    const relisting = create_version_relisting(connector_listing([V1]), ITEM);
    const previous = { reads: 2, since: T0.toISOString() };
    const now = new Date(T0.getTime() + 25 * HOUR_MS);

    await expect(judge_version_not_found(relisting, ITEM, V1, previous, now)).resolves.toEqual({
      kind: 'gone',
    });
  });

  it('treats a failed re-listing as confirming nothing', async () => {
    const relisting = create_version_relisting(connector_listing(new Error('503')), ITEM);

    await expect(judge_version_not_found(relisting, ITEM, V1, undefined, T0)).resolves.toEqual({
      kind: 'unconfirmed',
      streak: { reads: 1, since: T0.toISOString() },
    });
  });
});

describe('create_version_relisting', () => {
  it('reads the list once however many versions ask', async () => {
    const connector = connector_listing([V1]);
    const relisting = create_version_relisting(connector, ITEM);

    await relisting();
    await relisting();

    expect(connector.list_file_versions).toHaveBeenCalledTimes(1);
  });

  it('rethrows a listing failure once the run is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const relisting = create_version_relisting(
      connector_listing(new Error('aborted')),
      ITEM,
      controller.signal,
    );

    await expect(relisting()).rejects.toThrow('aborted');
  });
});
