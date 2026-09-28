import { AuthError, MailboxNotLicensedError } from '@wisecom/atlas-types';
import type {
  MailboxConfigConnector,
  MailboxConfigDocument,
  MailboxConfigRef,
  MailFolder,
  ObjectLockPolicy,
  TenantContext,
} from '@wisecom/atlas-types';
import { store_content_addressed_blob } from '@/services/backup/content-addressed-blob';
import { RULE_FOLDER_ACTIONS } from '@/shared/mailbox-config-fields';

export interface MailboxConfigCapture {
  /** The reference to record; the previous one when this run could not capture. */
  readonly ref: MailboxConfigRef | undefined;
  /** True when the captured document differs from the previous one. */
  readonly changed: boolean;
  readonly stored_objects: number;
  readonly warnings: string[];
  readonly errors: string[];
}

export interface MailboxConfigCaptureInput {
  readonly ctx: TenantContext;
  readonly connector: MailboxConfigConnector;
  readonly tenant_id: string;
  readonly owner_id: string;
  readonly folders: MailFolder[];
  readonly previous?: MailboxConfigRef | undefined;
  readonly object_lock_policy?: ObjectLockPolicy | undefined;
}

/** Maps every folder ID a rule action references to that folder's path, when the folder is known. */
function referenced_folder_paths(
  rules: Record<string, unknown>[],
  folders: MailFolder[],
): Record<string, string> {
  const path_by_id = new Map(folders.map((folder) => [folder.folder_id, folder.folder_path]));
  const paths: Record<string, string> = {};
  for (const rule of rules) {
    const actions = rule.actions;
    if (!actions || typeof actions !== 'object') continue;
    for (const [action, folder_id] of Object.entries(actions)) {
      if (!RULE_FOLDER_ACTIONS.has(action) || typeof folder_id !== 'string') continue;
      const path = path_by_id.get(folder_id);
      if (path !== undefined) paths[folder_id] = path;
    }
  }
  return paths;
}

/**
 * Captures inbox rules, master categories, and mailbox settings as one content-addressed
 * document. A missing grant becomes one warning and a transient failure one error; neither
 * discards the mail the run already captured, and both keep the previous reference.
 */
export async function capture_mailbox_config(
  input: MailboxConfigCaptureInput,
): Promise<MailboxConfigCapture> {
  const unchanged = { ref: input.previous, changed: false, stored_objects: 0 };
  try {
    const source = await input.connector.fetch_mailbox_config(input.tenant_id, input.owner_id);
    const document: MailboxConfigDocument = {
      ...source,
      rule_folder_paths: referenced_folder_paths(source.message_rules, input.folders),
    };
    const blob = await store_content_addressed_blob(
      input.ctx,
      `mailbox-config/${input.owner_id}`,
      Buffer.from(JSON.stringify(document)),
      input.object_lock_policy,
    );
    const changed = blob.checksum !== input.previous?.checksum;
    return {
      ref: changed
        ? {
            storage_key: blob.storage_key,
            checksum: blob.checksum,
            size_bytes: blob.size_bytes,
            captured_at: new Date().toISOString(),
          }
        : input.previous,
      changed,
      stored_objects: Number(blob.new_object),
      warnings: [],
      errors: [],
    };
  } catch (err) {
    if (err instanceof MailboxNotLicensedError) throw err;
    if (err instanceof AuthError) {
      return {
        ...unchanged,
        warnings: [
          'Mailbox configuration (inbox rules, categories, settings) not backed up: ' +
            'grant the MailboxSettings.Read application permission with admin consent.',
        ],
        errors: [],
      };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return { ...unchanged, warnings: [], errors: [`Mailbox configuration: ${reason}`] };
  }
}
