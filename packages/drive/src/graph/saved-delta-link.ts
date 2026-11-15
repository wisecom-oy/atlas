/**
 * How a saved delta link relates to the fields this version selects. A link pins the `$select` it
 * was created with, so fields added later never arrive through it.
 *
 * - `current`: resume from the link.
 * - `predates_package`: the link predates the `package` facet. Tracking recorded under it is
 *   unreliable, so the drive resets and every file rebaselines.
 * - `predates_sharing`: the link predates the `shared` facet. Tracking is still valid, so the drive
 *   is enumerated afresh without forgetting it: unchanged files are not downloaded again, and
 *   shared items get their permissions read.
 */
export type SavedDeltaLinkState = 'current' | 'predates_package' | 'predates_sharing';

/** Classifies a saved delta link by the select fields it carries. */
export function classify_saved_delta_link(delta_link: string): SavedDeltaLinkState {
  if (!delta_link.includes('package')) return 'predates_package';
  if (!delta_link.includes('shared')) return 'predates_sharing';
  return 'current';
}

/** How the first delta page is requested for a drive, and what that means for the result. */
export interface DeltaStartPlan {
  /** The saved link to resume from, or undefined for a fresh enumeration. */
  readonly resume_link: string | undefined;
  /** Tracking is invalid and the files the enumeration returns rebaseline as `created`. */
  readonly reset_detected: boolean;
  /** A fresh enumeration that keeps tracking; the re-crawl tombstones still run. */
  readonly full_enumeration: boolean;
}

/** Decides whether to resume a drive's saved link or enumerate the drive afresh. */
export function plan_delta_start(prev_delta_link: string | undefined): DeltaStartPlan {
  if (!prev_delta_link) {
    return { resume_link: undefined, reset_detected: false, full_enumeration: false };
  }
  const state = classify_saved_delta_link(prev_delta_link);
  if (state === 'predates_package') {
    return { resume_link: undefined, reset_detected: true, full_enumeration: false };
  }
  if (state === 'predates_sharing') {
    return { resume_link: undefined, reset_detected: false, full_enumeration: true };
  }
  return { resume_link: prev_delta_link, reset_detected: false, full_enumeration: false };
}
