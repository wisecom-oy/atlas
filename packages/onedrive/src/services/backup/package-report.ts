import type { OneDriveDeltaItem } from '@wisecom/atlas-types';
import {
  summarize_package_items,
  type PackageReport,
} from '@wisecom/atlas-core/services/shared/package-item-reporter';

/** Package accounting summed across every drive in one run. */
export interface PackageReportTotals {
  notebooks_detected: number;
  section_files_backed_up: number;
  warnings: string[];
}

/** Folds one drive's package report into the run-wide totals. */
export function accumulate_package_report(
  totals: PackageReportTotals,
  report: PackageReport,
): void {
  totals.notebooks_detected += report.notebooks_detected;
  totals.section_files_backed_up += report.section_files_backed_up;
  totals.warnings.push(...report.warnings);
}

/** Marks unprocessed delta items incomplete when a drive is interrupted. */
export function summarize_processed_package_items(
  items: readonly OneDriveDeltaItem[],
  failed_item_ids: ReadonlySet<string>,
  processed_item_ids: ReadonlySet<string>,
  interrupted: boolean,
): PackageReport {
  const incomplete_item_ids = new Set(failed_item_ids);
  if (interrupted) {
    for (const item of items) {
      if (!processed_item_ids.has(item.item_id)) incomplete_item_ids.add(item.item_id);
    }
  }
  return summarize_package_items(items, incomplete_item_ids);
}
