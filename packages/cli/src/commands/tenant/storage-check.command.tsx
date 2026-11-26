import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import type { ObjectLockMode } from '@wisecom/atlas-types/ports/backup/use-case.port';
import type {
  StorageCheckResult,
  StorageCheckUseCase,
  StorageConditionalWriteCheck,
  StorageDefaultRetention,
  StorageLifecycleCheck,
  StorageLifecycleMissingAction,
  StorageLifecycleUpdate,
} from '@wisecom/atlas-types';
import { STORAGE_CHECK_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { with_object_lock, with_tenant } from '@/commands/shared/shared-options';
import { banner_title } from '@/ui/banner-title';
import { Box } from 'ink';
import { Banner } from '@/ui/components/banner';
import { KeyValueList } from '@/ui/components/key-value-list';
import type { KeyValueItem } from '@/ui/components/key-value-list';
import { render_static_view } from '@/ui/render';
import { parse_object_lock_mode } from '@wisecom/atlas-core/services/shared/object-lock-policy';
import { parse_retention_days } from '@/command-object-lock';

type ContainerFactory = () => Container;

interface StorageCheckOptions {
  tenant?: string;
  lockMode?: string;
  retentionDays?: string;
  applyLifecycle?: boolean;
}

/** Registers `atlas storage-check` for immutability readiness validation. */
export function register_storage_check_command(
  program: Command,
  get_container: ContainerFactory,
): void {
  const command = program
    .command('storage-check')
    .description('Check S3/MinIO Object Lock, conditional writes, and lifecycle rules')
    .option(
      '--apply-lifecycle',
      'add the Atlas lifecycle rules the bucket lacks, keeping every existing rule',
    );
  with_object_lock(command, 'planned retention period in days');
  with_tenant(command).action((options: StorageCheckOptions) =>
    execute_storage_check(get_container(), options),
  );
}

async function execute_storage_check(
  container: Container,
  options: StorageCheckOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const request = build_request(options);
  const use_case = container.get<StorageCheckUseCase>(STORAGE_CHECK_USE_CASE_TOKEN);
  const result = await use_case.check_storage(tenant_id, request);

  const ready =
    result.reachable &&
    result.versioning_enabled &&
    result.object_lock_enabled &&
    result.mode_supported &&
    // A backend that does not enforce write conditions cannot keep two runs off one owner, and
    // every command that writes refuses it (issues #623, #915).
    result.conditional_writes.support !== 'ignored';

  await render_static_view(
    <Box flexDirection="column">
      <Banner title={banner_title('tenant', 'Storage Check')} />
      <KeyValueList items={build_result_items(result, ready)} />
    </Box>,
  );

  // A refused lifecycle update leaves the bucket as it was but fails the command that asked for it.
  if (!ready || result.lifecycle_update?.status === 'failed') process.exitCode = 1;
}

function build_result_items(result: StorageCheckResult, ready: boolean): KeyValueItem[] {
  const bucket_class = classify_bucket(result);
  const items: KeyValueItem[] = [
    { label: 'Bucket', value: result.bucket },
    { label: 'Reachable', value: result.reachable ? 'yes' : 'no' },
    { label: 'Versioning', value: result.versioning_enabled ? 'enabled' : 'disabled' },
    { label: 'Object Lock', value: result.object_lock_enabled ? 'enabled' : 'disabled' },
    { label: 'Bucket class', value: bucket_class.label, color: bucket_class.color },
    { label: 'Governance mode', value: result.mode_supported ? 'supported' : 'unsupported' },
    { label: 'Compliance mode', value: result.mode_supported ? 'supported' : 'unsupported' },
  ];
  if (result.object_lock_enabled) {
    items.push(describe_default_retention(result.default_retention));
  }
  items.push(describe_conditional_writes(result.conditional_writes));
  items.push(describe_lifecycle(result.lifecycle));
  if (result.lifecycle_update) items.push(describe_lifecycle_update(result.lifecycle_update));
  if (result.requested_mode) {
    items.push({ label: 'Requested mode', value: result.requested_mode });
  }
  if (result.requested_retention_days) {
    items.push({ label: 'Requested retention', value: `${result.requested_retention_days} days` });
  }
  if (result.resolved_retain_until) {
    items.push({ label: 'Resolved retain-until', value: result.resolved_retain_until });
  }
  items.push({
    label: 'Status',
    value: ready ? 'ready' : 'not-ready',
    color: ready ? 'green' : 'red',
  });
  return items;
}

/**
 * Classifies the bucket for operators: lock-capable buckets can take
 * retention policies, versioned-only and unversioned ones are legacy
 * (pre-#30) and need the migration runbook in docs/self-hosting/storage.md.
 */
function classify_bucket(result: StorageCheckResult): { label: string; color: string } {
  if (result.object_lock_enabled) return { label: 'lock-capable', color: 'green' };
  if (result.versioning_enabled) return { label: 'versioned-only (legacy)', color: 'yellow' };
  return { label: 'unversioned (legacy)', color: 'red' };
}

/**
 * Flags a bucket default retention. Atlas has not set one since 6.1.0, and a leftover default
 * locks every write without its own retention, including the staging uploads Atlas deletes.
 */
function describe_default_retention(retention?: StorageDefaultRetention): KeyValueItem {
  if (!retention) return { label: 'Default retention', value: 'none', color: 'green' };
  const period =
    retention.years !== undefined ? `${retention.years} years` : `${retention.days} days`;
  return {
    label: 'Default retention',
    value: `${retention.mode} ${period} (not set by Atlas since 6.1.0; remove it)`,
    color: 'yellow',
  };
}

/**
 * Reports the conditional-write probe. `ignored` is the dangerous answer: owner leases, the data
 * key bootstrap, create-only manifests and the identity registry all depend on the backend
 * enforcing these conditions, and every command that writes refuses such a bucket (issue #915).
 */
function describe_conditional_writes(check: StorageConditionalWriteCheck): KeyValueItem {
  const label = 'Conditional writes';
  if (check.support === 'supported') return { label, value: 'supported', color: 'green' };
  if (check.support === 'ignored') {
    return { label, value: `NOT ENFORCED: ${check.detail ?? 'see docs'}`, color: 'red' };
  }
  return { label, value: `not probed (${check.detail ?? 'no reason given'})`, color: 'yellow' };
}

/**
 * Reports the missing Atlas lifecycle actions, split by what fixes them: `--apply-lifecycle` for
 * absent rules and state-key rules. A base rule that is present stays as the operator or the
 * backend left it, for example MinIO dropping AbortIncompleteMultipartUpload.
 */
function describe_lifecycle(check: StorageLifecycleCheck): KeyValueItem {
  const label = 'Lifecycle rules';
  if (check.status === 'not_checked') {
    return { label, value: `not checked (${check.detail})`, color: 'yellow' };
  }
  if (check.missing_actions.length === 0) {
    return { label, value: 'Atlas actions present', color: 'green' };
  }
  const name = ({ rule_id, action }: StorageLifecycleMissingAction): string =>
    `${rule_id}/${action}`;
  const by_apply = check.missing_actions.filter((entry) => entry.fixed_by_apply).map(name);
  const kept_as_is = check.missing_actions.filter((entry) => !entry.fixed_by_apply).map(name);
  const groups = [
    ...(by_apply.length > 0 ? [`${by_apply.join(', ')} (fix with --apply-lifecycle)`] : []),
    ...(kept_as_is.length > 0
      ? [`${kept_as_is.join(', ')} (--apply-lifecycle keeps these rules as they are)`]
      : []),
  ];
  return { label, value: `missing Atlas actions: ${groups.join('; ')}`, color: 'yellow' };
}

/** Reports what `--apply-lifecycle` changed. A failure leaves the previous rules in place. */
function describe_lifecycle_update(update: StorageLifecycleUpdate): KeyValueItem {
  const label = 'Lifecycle update';
  if (update.status === 'unchanged') return { label, value: 'nothing to change', color: 'green' };
  if (update.status === 'failed') return { label, value: `FAILED: ${update.detail}`, color: 'red' };
  const changes = [
    ...describe_rule_ids('added', update.added_rule_ids),
    ...describe_rule_ids('reset', update.replaced_rule_ids),
  ];
  return { label, value: changes.join('; '), color: 'green' };
}

function describe_rule_ids(verb: string, rule_ids: readonly string[]): string[] {
  if (rule_ids.length === 0) return [];
  const count = rule_ids.length;
  return [`${verb} ${count} rule${count === 1 ? '' : 's'}: ${rule_ids.join(', ')}`];
}

function resolve_tenant_id(container: Container, options: StorageCheckOptions): string {
  if (options.tenant) return options.tenant;
  return container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
}

function build_request(options: StorageCheckOptions): {
  mode?: ObjectLockMode;
  retention_days?: number;
  apply_lifecycle?: boolean;
} {
  const mode = parse_object_lock_mode(options.lockMode);
  const retention_days = parse_retention_days(options.retentionDays);
  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(retention_days !== undefined ? { retention_days } : {}),
    ...(options.applyLifecycle === true ? { apply_lifecycle: true } : {}),
  };
}
