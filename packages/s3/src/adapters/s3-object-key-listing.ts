import { ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';

/** Which keys one paginated listing keeps, and how many before it stops. */
export interface ObjectKeyListing {
  readonly prefix: string;
  readonly keep: (last_modified: Date | undefined) => boolean;
  readonly limit?: number | undefined;
}

/** Lists the keys under a prefix that `keep` accepts, stopping early once `limit` are found. */
export async function list_object_keys(
  client: S3Client,
  bucket: string,
  listing: ObjectKeyListing,
): Promise<string[]> {
  const { prefix, keep, limit } = listing;
  const keys: string[] = [];
  let continuation_token: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuation_token,
        ...(limit !== undefined ? { MaxKeys: Math.min(limit, 1000) } : {}),
      }),
    );

    for (const obj of response.Contents ?? []) {
      if (obj.Key && keep(obj.LastModified)) keys.push(obj.Key);
    }
    if (limit !== undefined && keys.length >= limit) return keys.slice(0, limit);
    continuation_token = response.NextContinuationToken;
  } while (continuation_token);

  return keys;
}
