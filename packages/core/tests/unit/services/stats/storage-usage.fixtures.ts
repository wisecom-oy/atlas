import type {
  StorageIncompleteUpload,
  StorageInventory,
  StorageListedObject,
  StorageListingRequest,
  StorageObjectPage,
  StoragePartsPage,
  StorageUploadCursor,
  StorageUploadPage,
} from '@wisecom/atlas-types';

/** An incomplete upload and the sizes of its parts. */
export interface FakeUpload {
  readonly key: string;
  readonly parts: readonly number[];
  /** Completed or aborted after it was listed. */
  readonly gone?: boolean;
}

export interface FakeBucket {
  readonly objects: readonly StorageListedObject[];
  readonly uploads?: readonly FakeUpload[];
  /** Answers version listings the way the S3 adapter does after a refusal. */
  readonly deny_versions?: boolean;
  /** Answers part listings with `denied`, as for credentials without ListMultipartUploadParts. */
  readonly deny_parts?: boolean;
  readonly page_size?: number;
}

export interface FakeInventory extends StorageInventory {
  /** Requests made so far, counted the way the adapter reports them. */
  readonly requests: () => number;
  /** Fails the next request with a transient error, as an S3 503 would. */
  fail_next(): void;
}

/** An in-memory bucket behind the inventory port, paginating like S3 does. */
export function fake_inventory(bucket: FakeBucket): FakeInventory {
  const page_size = bucket.page_size ?? 2;
  let requests = 0;
  let fail_next = false;

  const paginate = <T>(
    items: readonly T[],
    marker: string | undefined,
  ): { slice: T[]; next?: string } => {
    const start = marker ? Number(marker) : 0;
    const end = start + page_size;
    return { slice: items.slice(start, end), ...(end < items.length ? { next: String(end) } : {}) };
  };
  const send = (count = 1): void => {
    requests += count;
    if (!fail_next) return;
    fail_next = false;
    throw Object.assign(new Error('Service Unavailable'), { name: 'SlowDown' });
  };

  return {
    requests: () => requests,
    fail_next: () => {
      fail_next = true;
    },
    async list_object_page(request: StorageListingRequest): Promise<StorageObjectPage> {
      const refused = request.mode === 'versions' && bucket.deny_versions === true;
      if (refused && request.cursor) throw new Error('AccessDenied mid-listing');
      const mode = refused ? 'current' : request.mode;
      send(refused ? 2 : 1);

      const visible = bucket.objects
        .filter((object) => object.key.startsWith(request.prefix))
        .filter((object) => mode === 'versions' || (object.is_latest && !object.is_delete_marker))
        .sort((a, b) => a.key.localeCompare(b.key));
      const entries: (StorageListedObject | string)[] = [];
      for (const object of visible) {
        const rest = object.key.slice(request.prefix.length);
        const slash = request.delimiter ? rest.indexOf(request.delimiter) : -1;
        if (slash < 0) entries.push(object);
        else if (!entries.includes(request.prefix + rest.slice(0, slash + 1))) {
          entries.push(request.prefix + rest.slice(0, slash + 1));
        }
      }
      const marker = request.cursor?.key_marker ?? request.cursor?.continuation_token;
      const { slice, next } = paginate(entries, marker);
      const cursor = mode === 'versions' ? { key_marker: next } : { continuation_token: next };
      return {
        mode,
        objects: slice.filter((entry): entry is StorageListedObject => typeof entry !== 'string'),
        common_prefixes: slice.filter((entry): entry is string => typeof entry === 'string'),
        requests: refused ? 2 : 1,
        ...(next ? { next: cursor } : {}),
      };
    },
    async list_incomplete_upload_page(cursor?: StorageUploadCursor): Promise<StorageUploadPage> {
      send();
      const { slice, next } = paginate(bucket.uploads ?? [], cursor?.key_marker);
      return {
        visible: true,
        uploads: slice.map((upload) => ({ key: upload.key, upload_id: `id-${upload.key}` })),
        ...(next ? { next: { key_marker: next } } : {}),
      };
    },
    async list_upload_parts_page(
      upload: StorageIncompleteUpload,
      part_marker?: string,
    ): Promise<StoragePartsPage> {
      send();
      if (bucket.deny_parts) return { status: 'denied', bytes: 0 };
      const found = (bucket.uploads ?? []).find((candidate) => candidate.key === upload.key);
      if (!found || found.gone) return { status: 'gone', bytes: 0 };
      const { slice, next } = paginate(found.parts, part_marker);
      const bytes = slice.reduce((sum, size) => sum + size, 0);
      return { status: 'listed', bytes, ...(next ? { next_part_marker: next } : {}) };
    },
  };
}

/** A version of `key`; `latest` false makes it noncurrent. */
export function version(key: string, size: number, latest = true): StorageListedObject {
  return { key, size, is_latest: latest, is_delete_marker: false };
}

export function marker(key: string): StorageListedObject {
  return { key, size: 0, is_latest: true, is_delete_marker: true };
}

/**
 * A bucket touching every workload, with versions, markers, staging, an upload whose parts span
 * two pages, and one that disappears between listing and sizing.
 */
export const MIXED_BUCKET: FakeBucket = {
  objects: [
    version('_meta/dek.enc', 300),
    version('data/m1/a', 1000),
    version('data/m1/b', 400),
    version('data/m1/b', 350, false),
    marker('attachments/m1/c'),
    version('attachments/m1/c', 700, false),
    version('manifests/m1/s1.json', 90),
    version('onedrive/data/o1/d', 5000),
    version('onedrive/staging/o1/e', 2000),
    version('sharepoint/data/s1/f', 3000),
    version('root-file', 11),
  ],
  uploads: [
    { key: 'onedrive/staging/o1/g', parts: [2500, 2500, 1000] },
    { key: 'onedrive/staging/o1/h', parts: [700], gone: true },
  ],
};
