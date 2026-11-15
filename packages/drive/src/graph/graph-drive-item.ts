import type { GraphFileSystemInfo, GraphIdentitySet } from '@wisecom/atlas-m365-graph';

/** A `driveItem` as the delta call and the single-item fetch return it. */
export interface GraphDeltaDriveItem {
  id?: string;
  name?: string;
  size?: number;
  webUrl?: string;
  eTag?: string;
  lastModifiedDateTime?: string;
  fileSystemInfo?: GraphFileSystemInfo;
  createdBy?: GraphIdentitySet;
  lastModifiedBy?: GraphIdentitySet;
  parentReference?: { path?: string };
  file?: Record<string, unknown>;
  folder?: Record<string, unknown>;
  package?: { type?: string };
  /** Present on the drive root only. */
  root?: Record<string, unknown>;
  /**
   * Under `Prefer: hierarchicalsharing`, present only where sharing was set on the item itself,
   * and as an empty object where it was just removed.
   */
  shared?: Record<string, unknown>;
  /**
   * Removal marker for `driveItem` delta. Graph uses this facet, NOT the
   * `@removed` annotation that `messages/delta` uses (issue #139). It must be
   * requested explicitly: `$select` strips it otherwise.
   */
  deleted?: { state?: string };
  /**
   * Non-null when Microsoft 365 has quarantined the item. Graph then refuses to
   * serve its content, and the refusal surfaces as an aborted transfer rather
   * than a clean 403, which `is_network_error` reads as retryable. Selecting the
   * facet lets the pipeline skip the item instead of spending the full Graph
   * retry budget on content that will never be served (issue #53).
   */
  malware?: Record<string, unknown>;
  '@removed'?: { reason: string };
  '@microsoft.graph.downloadUrl'?: string;
}

/** A delta item Graph returned with the id every record of the item is keyed by. */
export type IdentifiedGraphDeltaDriveItem = GraphDeltaDriveItem & { id: string };

/**
 * Fields Graph must return for a drive item: exactly the set the mapper reads. Shared by the delta
 * call and the single-item retry fetch of both providers, so a retried item maps identically to one
 * that arrived through delta.
 */
export const DRIVE_DELTA_SELECT_FIELDS = [
  'id',
  'name',
  'size',
  'webUrl',
  'eTag',
  'lastModifiedDateTime',
  'fileSystemInfo',
  'createdBy',
  'lastModifiedBy',
  'parentReference',
  'file',
  'folder',
  'package',
  'root',
  'shared',
  'deleted',
  'malware',
  '@microsoft.graph.downloadUrl',
].join(',');

/**
 * `Prefer` header for every delta request, the saved link and each next page included.
 *
 * `hierarchicalsharing` makes Graph return the `shared` facet only on items whose own sharing
 * changed, instead of on everything under a shared folder. A sharing change moves neither the eTag
 * nor the cTag, but it does bring the item back in delta, so the facet is how a backup tells which
 * re-presented items need their permissions read. Graph documents `deltashowsharingchanges` and its
 * `@microsoft.graph.sharedChanged` annotation for this, but with an application token it never
 * returns the annotation.
 */
export const DRIVE_DELTA_PREFER = 'hierarchicalsharing';
