import { isDeepStrictEqual } from 'node:util';
import { AuthError, MailboxNotLicensedError } from '@wisecom/atlas-types';
import type {
  MailboxConfigConnector,
  MailboxConfigDocument,
  MailboxConfigSource,
  MailboxConnector,
  SkippedMessageRule,
} from '@wisecom/atlas-types';
import { WRITABLE_MAILBOX_SETTINGS } from '@/shared/mailbox-config-fields';
import {
  folder_ids_by_path,
  map_rule_to_target,
  writable_rule,
} from '@/services/restore/message-rule-mapper';

export interface MailboxConfigRestoreTarget {
  readonly config: MailboxConfigConnector;
  readonly mailbox: MailboxConnector;
  readonly tenant_id: string;
  readonly target_id: string;
}

export interface MailboxConfigRestoreOutcome {
  categories_restored: number;
  settings_restored: boolean;
  rules_restored: number;
  skipped_rules: SkippedMessageRule[];
  errors: string[];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Runs one Graph write, keeping a per-item failure without masking a missing grant. */
async function attempt(
  outcome: MailboxConfigRestoreOutcome,
  label: string,
  write: () => Promise<void>,
): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (err) {
    if (err instanceof AuthError || err instanceof MailboxNotLicensedError) throw err;
    outcome.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function restore_categories(
  target: MailboxConfigRestoreTarget,
  snapshot: MailboxConfigDocument,
  current: MailboxConfigSource,
  outcome: MailboxConfigRestoreOutcome,
): Promise<void> {
  for (const category of snapshot.master_categories) {
    const name = text(category.displayName);
    if (!name) continue;
    const color = text(category.color) ?? 'none';
    const existing = current.master_categories.find((item) => item.displayName === name);
    if (existing && existing.color === color) continue;
    const existing_id = text(existing?.id);
    const done = await attempt(outcome, `Category "${name}"`, () =>
      existing_id
        ? target.config.update_master_category_color(
            target.tenant_id,
            target.target_id,
            existing_id,
            color,
          )
        : target.config.create_master_category(target.tenant_id, target.target_id, {
            displayName: name,
            color,
          }),
    );
    if (done) outcome.categories_restored++;
  }
}

async function restore_settings(
  target: MailboxConfigRestoreTarget,
  snapshot: MailboxConfigDocument,
  current: MailboxConfigSource,
  outcome: MailboxConfigRestoreOutcome,
): Promise<void> {
  const changes: Record<string, unknown> = {};
  for (const field of WRITABLE_MAILBOX_SETTINGS) {
    const wanted = snapshot.mailbox_settings[field];
    if (wanted === undefined || wanted === null) continue;
    if (!isDeepStrictEqual(wanted, current.mailbox_settings[field])) changes[field] = wanted;
  }
  if (Object.keys(changes).length === 0) return;
  outcome.settings_restored = await attempt(outcome, 'Mailbox settings', () =>
    target.config.update_mailbox_settings(target.tenant_id, target.target_id, changes),
  );
}

async function restore_rules(
  target: MailboxConfigRestoreTarget,
  snapshot: MailboxConfigDocument,
  current: MailboxConfigSource,
  outcome: MailboxConfigRestoreOutcome,
): Promise<void> {
  if (snapshot.message_rules.length === 0) return;
  const folders = await target.mailbox.list_mail_folders(target.tenant_id, target.target_id);
  const target_ids = folder_ids_by_path(folders);
  for (const rule of snapshot.message_rules) {
    const mapping = map_rule_to_target(rule, snapshot.rule_folder_paths, target_ids);
    if (!mapping.ok) {
      outcome.skipped_rules.push(mapping.skipped);
      continue;
    }
    const name = text(mapping.rule.displayName) ?? '(unnamed rule)';
    const existing = current.message_rules.find((item) => item.displayName === name);
    if (existing && isDeepStrictEqual(writable_rule(existing), mapping.rule)) continue;
    const existing_id = text(existing?.id);
    const done = await attempt(outcome, `Rule "${name}"`, () =>
      existing_id
        ? target.config.update_message_rule(
            target.tenant_id,
            target.target_id,
            existing_id,
            mapping.rule,
          )
        : target.config.create_message_rule(target.tenant_id, target.target_id, mapping.rule),
    );
    if (done) outcome.rules_restored++;
  }
}

/**
 * Applies a captured configuration in dependency order: categories first, because rules and
 * messages reference category names; then mailbox settings; then inbox rules, which reference
 * folders. Matching items that already agree with the snapshot are left untouched.
 */
export async function restore_mailbox_config_document(
  target: MailboxConfigRestoreTarget,
  snapshot: MailboxConfigDocument,
): Promise<MailboxConfigRestoreOutcome> {
  const current = await target.config.fetch_mailbox_config(target.tenant_id, target.target_id);
  const outcome: MailboxConfigRestoreOutcome = {
    categories_restored: 0,
    settings_restored: false,
    rules_restored: 0,
    skipped_rules: [],
    errors: [],
  };
  await restore_categories(target, snapshot, current, outcome);
  await restore_settings(target, snapshot, current, outcome);
  await restore_rules(target, snapshot, current, outcome);
  return outcome;
}
