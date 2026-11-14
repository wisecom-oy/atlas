/**
 * Per-run ordinals that refine request identity: which upload session, which
 * page of a listing, and how many times an identity has arrived.
 *
 * Ordinals are assigned in order of first arrival. Fragments of one file and
 * pages of one enumeration are sequential, so for those the order (and so the
 * ordinal) is the same in every run of the same workload, which is what lets a
 * replay match "page 3" or "fragment 2 of session 1" again. The raw session
 * URLs and cursor values used as map keys stay in memory only.
 */

/** Creates the run's ordinal registry. */
export function create_identity_ordinals() {
  const sessions = new Map();
  const pages = new Map();
  const arrivals = new Map();

  /** The 1-based ordinal of `value` among the distinct values seen under `key`. */
  const ordinal = (table, key, value) => {
    let seen = table.get(key);
    if (!seen) table.set(key, (seen = new Map()));
    if (!seen.has(value)) seen.set(value, seen.size + 1);
    return seen.get(value);
  };

  return {
    /** Ordinal of a raw upload-session URL among the sessions seen for its templated shape. */
    session_ordinal: (base, raw_url) => ordinal(sessions, base, raw_url),
    /** Ordinal of a raw cursor value among the cursors seen for a base identity. */
    page_ordinal: (base, cursor_value) => ordinal(pages, base, cursor_value),
    /** Counts one more arrival of an identity key and returns the 1-based occurrence. */
    next_occurrence(identity_key) {
      const occurrence = (arrivals.get(identity_key) ?? 0) + 1;
      arrivals.set(identity_key, occurrence);
      return occurrence;
    },
  };
}
