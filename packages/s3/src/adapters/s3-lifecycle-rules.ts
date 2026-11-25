import type { LifecycleRule } from '@aws-sdk/client-s3';

/** Days a replaced version is kept anywhere in the bucket, including `_meta/dek.enc`. */
export const DEFAULT_NONCURRENT_DAYS = 30;

/** Days a replaced version of a lease, cursor, pointer or summary is kept (issue #918). */
export const STATE_KEY_NONCURRENT_DAYS = 1;

/**
 * Aborts incomplete multipart uploads after 7 days and removes delete markers that no longer
 * reference any version. One combined rule: MinIO drops AbortIncompleteMultipartUpload and rejects
 * a rule whose only action is that abort.
 */
export const HOUSEKEEPING_RULE = {
  ID: 'atlas-housekeeping',
  Status: 'Enabled',
  Filter: { Prefix: '' },
  AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
  Expiration: { ExpiredObjectDeleteMarker: true },
} satisfies LifecycleRule;

/**
 * Expires noncurrent versions everywhere after 30 days. Versioning is on by default (Object Lock
 * implies it), so overwritten objects would otherwise keep stale versions forever. Atlas never
 * reads noncurrent versions; locked versions are retained until their lock expires.
 */
export const NONCURRENT_VERSIONS_RULE = {
  ID: 'atlas-expire-noncurrent-versions',
  Status: 'Enabled',
  Filter: { Prefix: '' },
  NoncurrentVersionExpiration: { NoncurrentDays: DEFAULT_NONCURRENT_DAYS },
} satisfies LifecycleRule;

/** One prefix of objects Atlas rewrites on every run or every few minutes, and its rule ID. */
export interface StateKeyPrefix {
  readonly rule_id: string;
  readonly prefix: string;
}

/**
 * Where Atlas keeps leases, delta cursors, Teams checkpoints, Outlook latest pointers and snapshot
 * summaries (docs/operations/storage-layout.md). Each is rewritten far more often than the 30-day
 * window assumes, and some backends refuse writes to a key holding 1,000 versions (issue #918).
 *
 * Never `_meta/` itself: `_meta/dek.enc` sits there, and its old versions are the recovery path
 * after a key re-wrap. `_meta/outlook-manifests/snapshots/` is written once per snapshot, so it
 * keeps the default window too. Every entry is matched by plain string prefix on S3 and MinIO.
 */
export const STATE_KEY_PREFIXES: readonly StateKeyPrefix[] = [
  { rule_id: 'atlas-state-versions-outlook-leases', prefix: '_meta/outlook-leases/' },
  { rule_id: 'atlas-state-versions-outlook-cursors', prefix: '_meta/outlook-cursors/' },
  { rule_id: 'atlas-state-versions-outlook-owners', prefix: '_meta/outlook-manifests/owners/' },
  { rule_id: 'atlas-state-versions-tenant-lease', prefix: '_meta/tenant-lease.json' },
  { rule_id: 'atlas-state-versions-onedrive', prefix: 'onedrive/_meta/' },
  { rule_id: 'atlas-state-versions-sharepoint', prefix: 'sharepoint/_meta/' },
  { rule_id: 'atlas-state-versions-contacts', prefix: 'contacts/_meta/' },
  { rule_id: 'atlas-state-versions-calendar', prefix: 'calendar/_meta/' },
  { rule_id: 'atlas-state-versions-teams', prefix: 'teams/_meta/' },
];

/** The rule that expires noncurrent versions under one state-key prefix after one day. */
function build_state_key_rule({ rule_id, prefix }: StateKeyPrefix): LifecycleRule {
  return {
    ID: rule_id,
    Status: 'Enabled',
    Filter: { Prefix: prefix },
    NoncurrentVersionExpiration: { NoncurrentDays: STATE_KEY_NONCURRENT_DAYS },
  };
}

/**
 * Every rule Atlas owns. Rules overlap by design: on S3 and MinIO every enabled rule that matches
 * a noncurrent version can expire it, so the shortest window applies to the state keys.
 */
export const ATLAS_LIFECYCLE_RULES: readonly LifecycleRule[] = [
  HOUSEKEEPING_RULE,
  NONCURRENT_VERSIONS_RULE,
  ...STATE_KEY_PREFIXES.map(build_state_key_rule),
];

/** The rules Atlas requested before issue #918, for a backend that refuses the full set. */
export const BASE_LIFECYCLE_RULES: readonly LifecycleRule[] = [
  HOUSEKEEPING_RULE,
  NONCURRENT_VERSIONS_RULE,
];

/** A lifecycle configuration after the Atlas rules were added or reset, and the rule IDs touched. */
export interface MergedLifecycleRules {
  readonly rules: readonly LifecycleRule[];
  readonly added_rule_ids: readonly string[];
  readonly replaced_rule_ids: readonly string[];
}

/**
 * Adds each Atlas rule whose ID the configuration lacks, and resets each state-key rule that is
 * disabled, lacks its expiry or filters on another prefix to its definition, in place. Every other
 * rule is kept exactly as it is and in its order, including a base rule an operator disabled or
 * edited: resetting that one could expire versions the operator chose to keep. State-key rules
 * only ever expire old versions of keys Atlas rewrites, and a misscoped one can put a one-day
 * window over `_meta/dek.enc`, so they are always reset.
 */
export function merge_atlas_rules(existing: readonly LifecycleRule[]): MergedLifecycleRules {
  const replaced_rule_ids: string[] = [];
  const rules = existing.map((rule) => {
    const state_key = STATE_KEY_PREFIXES.find(({ rule_id }) => rule_id === rule.ID);
    if (state_key === undefined || find_broken_state_action(rule, state_key.prefix) === undefined) {
      return rule;
    }
    replaced_rule_ids.push(state_key.rule_id);
    return build_state_key_rule(state_key);
  });
  const present_ids = new Set(existing.map((rule) => rule.ID));
  const missing = ATLAS_LIFECYCLE_RULES.filter((rule) => !present_ids.has(rule.ID));
  return {
    rules: [...rules, ...missing],
    added_rule_ids: missing.map((rule) => rule.ID ?? ''),
    replaced_rule_ids,
  };
}

/**
 * What a stored state-key rule lacks: an enabled noncurrent expiry, or its own prefix. `Prefix` is
 * reported when the rule filters on anything else, because a wider filter would shorten the window
 * for the whole bucket. Undefined when the rule is intact, including an edited but working window.
 */
export function find_broken_state_action(
  rule: LifecycleRule,
  prefix: string,
): 'NoncurrentVersionExpiration' | 'Prefix' | undefined {
  const expires = (rule.NoncurrentVersionExpiration?.NoncurrentDays ?? 0) > 0;
  if (rule.Status !== 'Enabled' || !expires) return 'NoncurrentVersionExpiration';
  if (stored_rule_prefix(rule) !== prefix) return 'Prefix';
  return undefined;
}

/** The key prefix a stored rule filters on, or `''` when it applies to the whole bucket. */
export function stored_rule_prefix(rule: LifecycleRule): string {
  return rule.Filter?.Prefix ?? rule.Filter?.And?.Prefix ?? rule.Prefix ?? '';
}

/**
 * IDs of state-key rules that a backend stored with a prefix other than their own. A backend that
 * drops the filter would apply the one-day window to the whole bucket, `_meta/dek.enc` included.
 */
export function find_misscoped_state_rules(stored: readonly LifecycleRule[]): string[] {
  return STATE_KEY_PREFIXES.filter(({ rule_id, prefix }) => {
    const rule = stored.find((candidate) => candidate.ID === rule_id);
    return rule !== undefined && stored_rule_prefix(rule) !== prefix;
  }).map(({ rule_id }) => rule_id);
}
