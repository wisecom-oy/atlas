import type {
  LatestReadableManifest,
  ReadableManifestListing,
} from '@/ports/storage/readable-listing.port';
import type { TenantContext } from '@/ports/tenant/context.port';
import { stub_tenant_context } from '@/testing/stub-tenant-context';

/** A delta item both drive providers accept: a file, live or deleted. */
export interface StubDriveItem {
  readonly item_id: string;
  readonly drive_id: string;
  readonly kind: 'file';
  readonly file_name: string;
  readonly parent_path: string;
  readonly size_bytes: number;
  readonly deleted: boolean;
  readonly etag?: string;
}

/** One delta answer, in the shape both drive connectors return. */
export interface StubDriveDelta {
  drive_id: string;
  delta_link: string;
  items: StubDriveItem[];
  reset_detected: boolean;
}

/** A drive or document library that answers delta the way Graph does. */
export interface StubGraphDrive {
  readonly drive_id: string;
  /** Creates the file, or changes its content when it exists. */
  readonly put_file: (file_name: string) => void;
  readonly remove_file: (file_name: string) => void;
  /** Everything that exists when `delta_link` is undefined, else the changes since that link. */
  readonly delta: (delta_link?: string) => StubDriveDelta;
  /** The link each delta read resumed from, in order; undefined is a full enumeration. */
  readonly requested_links: (string | undefined)[];
}

/** Builds a scripted drive. A full enumeration lists live files only, as Graph's does. */
export function stub_graph_drive(drive_id = 'drive-1'): StubGraphDrive {
  let sequence = 0;
  const live = new Map<string, { changed_at: number }>();
  const removed = new Map<string, number>();
  const requested_links: (string | undefined)[] = [];
  const live_item = (file_name: string, changed_at: number): StubDriveItem => ({
    item_id: `id-${file_name}`,
    drive_id,
    kind: 'file',
    file_name,
    parent_path: '/Documents',
    size_bytes: 8,
    deleted: false,
    etag: `etag-${file_name}-${changed_at}`,
  });
  const removed_item = (file_name: string): StubDriveItem => ({
    item_id: `id-${file_name}`,
    drive_id,
    kind: 'file',
    file_name: '',
    parent_path: '',
    size_bytes: 0,
    deleted: true,
  });
  return {
    drive_id,
    requested_links,
    put_file: (file_name): void => {
      removed.delete(file_name);
      live.set(file_name, { changed_at: ++sequence });
    },
    remove_file: (file_name): void => {
      live.delete(file_name);
      removed.set(file_name, ++sequence);
    },
    delta: (delta_link): StubDriveDelta => {
      requested_links.push(delta_link);
      const since = delta_link === undefined ? -1 : Number(delta_link.split(':')[1]);
      const changed = [...live]
        .filter(([, file]) => file.changed_at > since)
        .map(([file_name, file]) => live_item(file_name, file.changed_at));
      const gone =
        delta_link === undefined
          ? []
          : [...removed]
              .filter(([, at]) => at > since)
              .map(([file_name]) => removed_item(file_name));
      return {
        drive_id,
        delta_link: `link:${sequence}`,
        items: [...changed, ...gone],
        reset_detected: false,
      };
    },
  };
}

/** In-memory manifest, cursor and version index stores for one drive owner or site. */
export interface StubDriveStores<M, C> {
  readonly ctx: TenantContext;
  /** The storage key a snapshot's manifest is written under, as the real repositories build it. */
  readonly manifest_key: (snapshot_id: string) => string;
  /** Removes a snapshot's manifest, as `delete -s` or a quarantine does. */
  readonly remove_manifest: (snapshot_id: string) => void;
  /** The manifests still stored, oldest first. */
  readonly stored_manifests: () => M[];
  readonly save_manifest: (ctx: TenantContext, manifest: M) => Promise<void>;
  readonly find_latest_readable: () => Promise<LatestReadableManifest<M>>;
  readonly list_readable_snapshots: () => Promise<ReadableManifestListing<M>>;
  /** Every cursor saved, oldest first. `load` answers the last one; push to script a stored one. */
  readonly saved_cursors: C[];
  readonly load_cursor: () => Promise<C | undefined>;
  readonly save_cursor: (ctx: TenantContext, cursor: C) => Promise<void>;
  /** Calls to `load_version_watermarks`, which seeds a run that cannot use its cursor's. */
  readonly watermark_seeds: () => number;
  readonly load_version_watermarks: () => Promise<Record<string, never>>;
  readonly write_run_index: () => Promise<void>;
}

/**
 * Builds the stores. Manifests are written to the context's storage under the real key layout, so
 * a listing of the manifest prefix sees exactly the snapshots that exist.
 */
export function stub_drive_stores<M extends { snapshot_id: string; created_at: Date }, C>(
  workload: 'onedrive' | 'sharepoint',
  owner_id: string,
): StubDriveStores<M, C> {
  const { ctx, objects } = stub_tenant_context();
  Object.assign(ctx.storage, {
    list_stale: async () => [],
    abort_incomplete_uploads: async () => 0,
  });
  const prefix = `${workload}/manifests/${owner_id}/`;
  const manifest_key = (snapshot_id: string): string => `${prefix}${snapshot_id}.json`;
  const stored_manifests = (): M[] =>
    Object.keys(objects)
      .filter((key) => key.startsWith(prefix))
      .map((key) => JSON.parse(objects[key]!.toString('utf-8')) as M)
      .map((manifest) => ({ ...manifest, created_at: new Date(manifest.created_at) }))
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  const newest_first = (): M[] => stored_manifests().reverse();
  const saved_cursors: C[] = [];
  let watermark_seeds = 0;
  return {
    ctx,
    manifest_key,
    remove_manifest: (snapshot_id): void => {
      delete objects[manifest_key(snapshot_id)];
    },
    stored_manifests,
    save_manifest: async (_ctx, manifest): Promise<void> => {
      objects[manifest_key(manifest.snapshot_id)] = Buffer.from(JSON.stringify(manifest));
    },
    find_latest_readable: async () => ({ manifest: newest_first()[0], unreadable_keys: [] }),
    list_readable_snapshots: async () => ({ manifests: newest_first(), unreadable_keys: [] }),
    saved_cursors,
    load_cursor: async () => saved_cursors.at(-1),
    save_cursor: async (_ctx, cursor): Promise<void> => {
      // Through JSON, as the real repository stores it: a run that keeps mutating its maps after
      // the save must not change what was saved.
      saved_cursors.push(JSON.parse(JSON.stringify(cursor)) as C);
    },
    watermark_seeds: () => watermark_seeds,
    load_version_watermarks: async (): Promise<Record<string, never>> => {
      watermark_seeds++;
      return {};
    },
    write_run_index: async () => undefined,
  };
}
