/**
 * Accounting for Graph `package` items (OneNote notebooks) in drive backups.
 *
 * A notebook root carries the `package` facet alongside a `folder` facet, so
 * backup treats it as a folder and stores its `.one` / `.onetoc2` children as
 * ordinary files. The content is therefore captured, but without this
 * accounting nothing in the run says a notebook exists or whether it came
 * through whole.
 *
 * That matters because a notebook is only usable if all of its parts are
 * present: a `.onetoc2` table of contents stored without its sibling section
 * files restores as a notebook that will not open. Partial capture is reported
 * per notebook rather than averaged into the run's file counters.
 *
 * @see https://learn.microsoft.com/en-us/graph/api/resources/package
 */

/** The delta-item fields this accounting needs, shared by OneDrive and SharePoint. */
export interface PackageAwareDeltaItem {
  readonly item_id: string;
  readonly file_name: string;
  readonly parent_path: string;
  readonly kind: 'file' | 'folder';
  readonly deleted: boolean;
  /** Graph package facet type (e.g. `oneNote`); absent for ordinary items. */
  readonly package_type?: string | undefined;
}

export interface PackageReport {
  /** Package roots seen in this delta batch. */
  readonly notebooks_detected: number;
  /** Files stored from inside those packages. */
  readonly section_files_backed_up: number;
  /** One line per notebook that came through incomplete. */
  readonly warnings: string[];
}

/**
 * Summarizes package items in one delta batch.
 *
 * @param items - Every item in the batch, roots and children alike.
 * @param failed_item_ids - Items that failed to back up in this run.
 */
export function summarize_package_items(
  items: readonly PackageAwareDeltaItem[],
  failed_item_ids: ReadonlySet<string>,
): PackageReport {
  const roots = items.filter((i) => i.package_type !== undefined && !i.deleted);
  if (roots.length === 0) {
    return { notebooks_detected: 0, section_files_backed_up: 0, warnings: [] };
  }

  const warnings: string[] = [];
  let section_files_backed_up = 0;

  for (const root of roots) {
    const root_path = join_path(root.parent_path, root.file_name);
    const children = items.filter(
      (i) => i.kind === 'file' && !i.deleted && is_inside(i.parent_path, root_path),
    );
    const failed = children.filter((c) => failed_item_ids.has(c.item_id));

    section_files_backed_up += children.length - failed.length;

    if (failed.length > 0) {
      warnings.push(
        `OneNote notebook "${root.file_name}" (${root_path}) is INCOMPLETE in this backup: ` +
          `${failed.length} of ${children.length} section file(s) failed ` +
          `(${failed.map((f) => f.file_name).join(', ')}). ` +
          'A partially captured notebook may not open after restore.',
      );
    }
  }

  return { notebooks_detected: roots.length, section_files_backed_up, warnings };
}

/** Joins a parent path and name into a normalized `/a/b` path. */
function join_path(parent_path: string, name: string): string {
  return parent_path === '/' ? `/${name}` : `${parent_path}/${name}`;
}

/** True when `path` is the given root or nested beneath it. */
function is_inside(path: string, root_path: string): boolean {
  return path === root_path || path.startsWith(`${root_path}/`);
}
