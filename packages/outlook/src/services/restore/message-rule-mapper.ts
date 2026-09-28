import type { MailFolder, SkippedMessageRule } from '@wisecom/atlas-types';
import { RULE_FOLDER_ACTIONS } from '@/shared/mailbox-config-fields';

/** Rule fields Graph accepts on create and update. */
const WRITABLE_RULE_FIELDS = [
  'displayName',
  'sequence',
  'isEnabled',
  'conditions',
  'exceptions',
  'actions',
] as const;

export type RuleMapping =
  | { readonly ok: true; readonly rule: Record<string, unknown> }
  | { readonly ok: false; readonly skipped: SkippedMessageRule };

/** Keeps only the fields a rule can be created or updated with. */
export function writable_rule(rule: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of WRITABLE_RULE_FIELDS) {
    if (rule[field] !== undefined && rule[field] !== null) result[field] = rule[field];
  }
  return result;
}

/** Target folder IDs keyed by lower-cased mailbox path. */
export function folder_ids_by_path(folders: MailFolder[]): Map<string, string> {
  return new Map(folders.map((folder) => [folder.folder_path.toLowerCase(), folder.folder_id]));
}

/**
 * Rewrites a rule's folder actions from source folder IDs to the target mailbox's folders,
 * matched by path. A rule whose folder cannot be found is skipped rather than created with a
 * reference that points nowhere.
 */
export function map_rule_to_target(
  rule: Record<string, unknown>,
  source_paths: Record<string, string>,
  target_ids: Map<string, string>,
): RuleMapping {
  const name = typeof rule.displayName === 'string' ? rule.displayName : '(unnamed rule)';
  if (rule.isReadOnly === true) {
    return { ok: false, skipped: { name, reason: 'read-only rule managed by Exchange' } };
  }
  const writable = writable_rule(rule);
  const actions = writable.actions;
  if (!actions || typeof actions !== 'object') return { ok: true, rule: writable };
  const mapped: Record<string, unknown> = { ...actions };
  for (const [action, folder_id] of Object.entries(actions)) {
    if (!RULE_FOLDER_ACTIONS.has(action) || typeof folder_id !== 'string') continue;
    const path = source_paths[folder_id];
    const target_id = path === undefined ? undefined : target_ids.get(path.toLowerCase());
    if (target_id === undefined) {
      const where = path === undefined ? 'a folder that was not backed up' : `folder "${path}"`;
      return {
        ok: false,
        skipped: { name, reason: `${action} targets ${where}, which the target mailbox lacks` },
      };
    }
    mapped[action] = target_id;
  }
  return { ok: true, rule: { ...writable, actions: mapped } };
}
