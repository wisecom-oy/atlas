import {
  ListObjectVersionsCommand,
  type ListObjectVersionsCommandOutput,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { StorageObjectVersion } from '@wisecom/atlas-types';

/** Lists every object version and delete marker under a prefix, following the listing's pages. */
export async function list_object_versions(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<StorageObjectVersion[]> {
  const versions: StorageObjectVersion[] = [];
  for await (const page of list_object_version_pages(client, bucket, prefix)) {
    for (const version of page) versions.push(version);
  }
  return versions;
}

/**
 * Yields the versions and delete markers under a prefix one `ListObjectVersions` page (up to 1,000
 * entries) at a time. The next page is requested only when the caller asks for it.
 */
export async function* list_object_version_pages(
  client: S3Client,
  bucket: string,
  prefix: string,
): AsyncGenerator<StorageObjectVersion[]> {
  let key_marker: string | undefined;
  let version_id_marker: string | undefined;

  do {
    const response = await client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: prefix,
        KeyMarker: key_marker,
        VersionIdMarker: version_id_marker,
      }),
    );
    yield versions_of(response);

    key_marker = response.NextKeyMarker;
    version_id_marker = response.NextVersionIdMarker;
    if (!response.IsTruncated) break;
  } while (true);
}

function versions_of(response: ListObjectVersionsCommandOutput): StorageObjectVersion[] {
  const versions: StorageObjectVersion[] = [];
  for (const version of response.Versions ?? []) {
    if (version.Key && version.VersionId) {
      versions.push({
        key: version.Key,
        version_id: version.VersionId,
        is_delete_marker: false,
        ...currency_of(version.IsLatest),
        ...(version.Size !== undefined && { size_bytes: version.Size }),
      });
    }
  }

  for (const marker of response.DeleteMarkers ?? []) {
    if (marker.Key && marker.VersionId) {
      versions.push({
        key: marker.Key,
        version_id: marker.VersionId,
        is_delete_marker: true,
        ...currency_of(marker.IsLatest),
      });
    }
  }
  return versions;
}

/**
 * The listing's own statement of whether a version is current. A backend that leaves `IsLatest`
 * out says nothing, and that must stay unknown rather than read as noncurrent: a caller that
 * deletes old versions would otherwise delete the current one.
 */
function currency_of(is_latest: boolean | undefined): { is_latest?: boolean } {
  return is_latest === undefined ? {} : { is_latest };
}
