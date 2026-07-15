import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import type { StatsUseCase, SharePointSiteConnector } from '@wisecom/atlas-types';
import { STATS_USE_CASE_TOKEN, SHAREPOINT_CONNECTOR_TOKEN } from '@wisecom/atlas-types';
import type { BucketStats, MailboxStats, DriveStats } from '@wisecom/atlas-types';
import { resolve_owner } from '@/commands/onedrive-command.handlers';
import { print_bucket_stats, print_mailbox_stats } from '@/commands/stats-outlook.view';
import { print_drive_stats } from '@/commands/stats-drive.view';

type ContainerFactory = () => Container;
type StatsServiceName = 'outlook' | 'onedrive' | 'sharepoint';
type ServiceStats = BucketStats | MailboxStats | DriveStats;

interface StatsOptions {
  tenant?: string;
  mailbox?: string;
  owner?: string;
  site?: string;
  service?: string;
  top?: string;
  json?: boolean;
}

const SERVICE_NAMES: StatsServiceName[] = ['outlook', 'onedrive', 'sharepoint'];
const DEFAULT_TOP = 20;

/** Registers the `atlas stats` subcommand for storage statistics. */
export function register_stats_command(program: Command, get_container: ContainerFactory): void {
  program
    .command('stats')
    .description('Show storage statistics for Outlook, OneDrive, and SharePoint backups')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('-m, --mailbox <email>', 'Outlook statistics for a specific mailbox')
    .option('-o, --owner <email|id>', 'OneDrive statistics for a specific owner')
    .option('-s, --site <url|id>', 'SharePoint statistics for a specific site')
    .option('--service <name>', 'limit output to one service: outlook, onedrive, sharepoint, all')
    .option('--top <n>', `maximum owner/site rows in drive tables (default ${DEFAULT_TOP})`)
    .option('--json', 'output raw JSON instead of formatted tables')
    .action((options: StatsOptions) => execute_stats(get_container(), options));
}

/** Collects stats for every selected service, then prints tables or a single JSON payload. */
async function execute_stats(container: Container, options: StatsOptions): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const services = resolve_services(options);
  const top = parse_top(options.top);
  const stats = container.get<StatsUseCase>(STATS_USE_CASE_TOKEN);

  const collected: [StatsServiceName, ServiceStats][] = [];
  for (const service of services) {
    const result = await collect_service_stats(container, stats, tenant_id, service, options);
    collected.push([service, result]);
  }

  if (options.json) {
    const [first] = collected;
    const payload =
      collected.length === 1 && first !== undefined ? first[1] : Object.fromEntries(collected);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  for (const [, result] of collected) {
    await print_service_stats(result, top);
  }
}

/** Determines which services to query from scope flags and --service. */
function resolve_services(options: StatsOptions): StatsServiceName[] {
  const scoped: StatsServiceName[] = [];
  if (options.mailbox) scoped.push('outlook');
  if (options.owner) scoped.push('onedrive');
  if (options.site) scoped.push('sharepoint');
  if (scoped.length > 1) {
    throw new Error('Use only one of --mailbox, --owner, or --site at a time');
  }

  const requested = options.service ?? 'all';
  if (requested !== 'all' && !SERVICE_NAMES.includes(requested as StatsServiceName)) {
    throw new Error(
      `Unknown --service "${requested}"; expected outlook, onedrive, sharepoint, or all`,
    );
  }
  if (scoped.length === 1) {
    if (requested !== 'all' && requested !== scoped[0]) {
      throw new Error(`--service ${requested} conflicts with the ${scoped[0]} scope flag`);
    }
    return scoped;
  }
  return requested === 'all' ? [...SERVICE_NAMES] : [requested as StatsServiceName];
}

/** Fetches stats for one service, resolving mailbox/owner/site scope flags. */
async function collect_service_stats(
  container: Container,
  stats: StatsUseCase,
  tenant_id: string,
  service: StatsServiceName,
  options: StatsOptions,
): Promise<ServiceStats> {
  if (service === 'outlook') {
    return options.mailbox
      ? stats.get_mailbox_stats(tenant_id, options.mailbox)
      : stats.get_bucket_stats(tenant_id);
  }
  if (service === 'onedrive') {
    if (!options.owner) return stats.get_onedrive_stats(tenant_id);
    const owner = await resolve_owner(container, tenant_id, options.owner);
    return stats.get_onedrive_stats(tenant_id, owner.object_id);
  }
  if (!options.site) return stats.get_sharepoint_stats(tenant_id);
  const connector = container.get<SharePointSiteConnector>(SHAREPOINT_CONNECTOR_TOKEN);
  const site = await connector.resolve_site(tenant_id, options.site);
  return stats.get_sharepoint_stats(tenant_id, site.site_id);
}

/** Dispatches to the matching view based on the result shape. */
async function print_service_stats(result: ServiceStats, top: number): Promise<void> {
  if ('service' in result) return print_drive_stats(result, top);
  if ('mailbox_count' in result) return print_bucket_stats(result);
  return print_mailbox_stats(result);
}

/** Resolves the tenant ID from CLI flag or config. */
function resolve_tenant_id(container: Container, options: StatsOptions): string {
  if (options.tenant) return options.tenant;
  return container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
}

/** Parses and validates the --top row limit. */
function parse_top(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TOP;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('--top must be a positive integer');
  }
  return value;
}
