/**
 * Reports version downloads that failed for an unexpected reason as one run error. Those versions
 * are left out of the snapshot, so the run is incomplete and exits partial (issue #92).
 */
export function build_version_errors(total_versions_failed: number): string[] {
  if (total_versions_failed === 0) return [];
  return [
    `${total_versions_failed} version download(s) failed unexpectedly ` +
      `-- see the per-version reasons above; those versions are not in this snapshot`,
  ];
}
