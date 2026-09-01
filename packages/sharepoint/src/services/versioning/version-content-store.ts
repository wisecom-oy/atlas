import { createHash } from 'node:crypto';
import type {
  SharePointSiteConnector,
  SharePointDeltaItem,
  SharePointFileVersion,
  TenantContext,
} from '@wisecom/atlas-types';
import { stream_to_content_addressed_storage } from '@wisecom/atlas-core/services/shared/stream-encrypt-upload';
import { LARGE_FILE_THRESHOLD } from '@/services/backup/large-file-pipeline';
import {
  sharepoint_data_key,
  sharepoint_staging_key,
  sharepoint_staging_prefix,
} from '@/services/shared/storage-keys';

export interface StoredVersionContent {
  readonly checksum: string;
  readonly storage_key: string;
  readonly deduplicated: boolean;
}

/**
 * Wraps a failure that came from Graph rather than from object storage.
 *
 * The distinction is load-bearing: a Graph failure is classified (an expired
 * version is expected, anything else blocks the watermark so the next run
 * retries), whereas a storage failure must keep propagating as it always has.
 */
export class VersionDownloadError extends Error {
  constructor(readonly source: unknown) {
    super('Version download failed');
    this.name = 'VersionDownloadError';
  }
}

/**
 * Stores one historical version's content, content-addressed.
 *
 * Versions at or above {@link LARGE_FILE_THRESHOLD} are streamed through a
 * staging key so the bytes are never held whole; smaller ones take the single
 * PUT. A version has no size ceiling of its own, so without the streamed path
 * a large file's history is the easiest way to exhaust the heap.
 *
 * @throws VersionDownloadError when the bytes could not be read from Graph.
 */
export async function store_version_content(
  connector: SharePointSiteConnector,
  item: SharePointDeltaItem,
  site_id: string,
  ctx: TenantContext,
  version: SharePointFileVersion,
): Promise<StoredVersionContent> {
  if (version.size_bytes >= LARGE_FILE_THRESHOLD) {
    return await store_streamed(connector, item, site_id, ctx, version);
  }
  return await store_buffered(connector, item, site_id, ctx, version);
}

async function store_streamed(
  connector: SharePointSiteConnector,
  item: SharePointDeltaItem,
  site_id: string,
  ctx: TenantContext,
  version: SharePointFileVersion,
): Promise<StoredVersionContent> {
  const chunks = await open_version_stream(connector, item, version);

  const result = await stream_to_content_addressed_storage(ctx, tag_source_errors(chunks), {
    staging_key: sharepoint_staging_key(site_id, item.item_id),
    staging_prefix: sharepoint_staging_prefix(site_id),
    build_data_key: (checksum) => sharepoint_data_key(site_id, checksum),
  });

  return {
    checksum: result.checksum,
    storage_key: result.storage_key,
    deduplicated: result.deduplicated,
  };
}

async function store_buffered(
  connector: SharePointSiteConnector,
  item: SharePointDeltaItem,
  site_id: string,
  ctx: TenantContext,
  version: SharePointFileVersion,
): Promise<StoredVersionContent> {
  let content: Buffer;
  try {
    content = await connector.download_file_version(
      item.drive_id,
      item.item_id,
      version.version_id,
    );
  } catch (err) {
    throw new VersionDownloadError(err);
  }

  const checksum = createHash('sha256').update(content).digest('hex');
  const storage_key = sharepoint_data_key(site_id, checksum);
  const deduplicated = await ctx.storage.exists(storage_key);
  if (!deduplicated) await ctx.storage.put(storage_key, ctx.encrypt(content));

  return { checksum, storage_key, deduplicated };
}

async function open_version_stream(
  connector: SharePointSiteConnector,
  item: SharePointDeltaItem,
  version: SharePointFileVersion,
): Promise<AsyncIterable<Buffer>> {
  try {
    return await connector.stream_file_version(
      item.drive_id,
      item.item_id,
      version.version_id,
      version.size_bytes,
    );
  } catch (err) {
    throw new VersionDownloadError(err);
  }
}

/** Re-labels mid-transfer read failures so storage failures stay distinguishable. */
async function* tag_source_errors(chunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const iterator = chunks[Symbol.asyncIterator]();
  while (true) {
    let next: IteratorResult<Buffer>;
    try {
      next = await iterator.next();
    } catch (err) {
      throw new VersionDownloadError(err);
    }
    if (next.done === true) return;
    yield next.value;
  }
}
