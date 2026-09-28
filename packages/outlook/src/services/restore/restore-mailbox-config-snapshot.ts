import { createHash } from 'node:crypto';
import { assert_mailbox_exists } from '@wisecom/atlas-core/services/shared/mailbox-assertions';
import { NotFoundError } from '@wisecom/atlas-types';
import type {
  MailboxConfigConnector,
  MailboxConfigDocument,
  MailboxConfigRef,
  MailboxConfigRestoreResult,
  MailboxConnector,
  ManifestRepository,
  RestoreOptions,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { load_snapshot_chain } from '@/services/restore/snapshot-chain-loader';
import { restore_mailbox_config_document } from '@/services/restore/mailbox-config-restore';

export interface MailboxConfigRestoreDependencies {
  readonly tenant_factory: TenantContextFactory;
  readonly manifests: ManifestRepository;
  readonly mailbox_connector: MailboxConnector;
  readonly config_connector: MailboxConfigConnector | undefined;
}

function is_record_list(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every((item) => item && typeof item === 'object');
}

function is_record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Decrypts the document, checks it against the manifest checksum, and validates its shape. */
async function read_config_document(
  ctx: TenantContext,
  ref: MailboxConfigRef,
): Promise<MailboxConfigDocument> {
  const raw = ctx.decrypt(await ctx.storage.get(ref.storage_key), ref.storage_key);
  if (createHash('sha256').update(raw).digest('hex') !== ref.checksum) {
    throw new Error('Mailbox configuration backup checksum does not match its manifest');
  }
  const parsed: unknown = JSON.parse(raw.toString('utf8'));
  if (
    !is_record(parsed) ||
    !is_record_list(parsed.message_rules) ||
    !is_record_list(parsed.master_categories) ||
    !is_record(parsed.mailbox_settings) ||
    !is_record(parsed.rule_folder_paths)
  ) {
    throw new Error('Mailbox configuration backup has an unexpected shape');
  }
  const paths: Record<string, string> = {};
  for (const [id, path] of Object.entries(parsed.rule_folder_paths)) {
    if (typeof path === 'string') paths[id] = path;
  }
  return {
    message_rules: parsed.message_rules,
    master_categories: parsed.master_categories,
    mailbox_settings: parsed.mailbox_settings,
    rule_folder_paths: paths,
  };
}

/** Restores the configuration a snapshot holds into its own mailbox or an explicit target. */
export async function restore_mailbox_config_snapshot(
  deps: MailboxConfigRestoreDependencies,
  tenant_id: string,
  snapshot_id: string,
  options: Pick<RestoreOptions, 'target_mailbox'> = {},
): Promise<MailboxConfigRestoreResult> {
  if (!deps.config_connector) throw new Error('Mailbox configuration connector is not configured');
  const ctx = await deps.tenant_factory.create(tenant_id);
  try {
    const chain = await load_snapshot_chain(deps.manifests, ctx, snapshot_id);
    const ref = chain.find((manifest) => manifest.mailbox_config)?.mailbox_config;
    if (!ref) {
      throw new NotFoundError(`Snapshot ${snapshot_id} holds no mailbox configuration`);
    }
    const target_id = options.target_mailbox?.toLowerCase() ?? chain[0]!.owner_id;
    await assert_mailbox_exists(deps.mailbox_connector, tenant_id, target_id);
    const document = await read_config_document(ctx, ref);
    const outcome = await restore_mailbox_config_document(
      {
        config: deps.config_connector,
        mailbox: deps.mailbox_connector,
        tenant_id,
        target_id,
      },
      document,
    );
    return { snapshot_id, ...outcome };
  } finally {
    ctx.destroy();
  }
}
