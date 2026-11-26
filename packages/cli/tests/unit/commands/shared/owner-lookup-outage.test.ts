import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import { CachingIdentityResolver } from '@wisecom/atlas-core/adapters/identity/caching-identity-resolver.adapter';
import { STORED_BACKUPS_GRAPH_WAIT_MS } from '@wisecom/atlas-core/adapters/identity/graph-identity-lookup';
import { GraphUserIdentityResolver } from '@wisecom/atlas-m365-graph';
import {
  BACKUP_USE_CASE_TOKEN,
  CATALOG_USE_CASE_TOKEN,
  GraphUnavailableError,
  USER_IDENTITY_RESOLVER_TOKEN,
  type TenantContext,
  type TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  ATTEMPTS_PER_RETRY_CHAIN,
  GraphOutageFault,
} from '@wisecom/atlas-types/testing/graph-outage-fault';
import { InMemoryIdentityRegistryRepository } from '@wisecom/atlas-types/testing/in-memory-identity-registry';
import { execute_outlook_backup } from '@/commands/outlook/backup.handlers';
import { execute_outlook_list } from '@/commands/outlook/catalog.handlers';

vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => {}) }));

/**
 * A Graph outage from the start of a run, for a mailbox the identity registry already knows, run
 * through the real Graph retry loop. Issue #882: a backup spends one budget on the owner lookup and
 * stops, instead of falling back and spending a second one while it holds the lease. Issue #887: a
 * command that only reads backups answers from the registry after the bounded wait.
 */
const TENANT = 'tenant-abc';
const ADDRESS = 'john.doe@example.com';
const STORED_ID = 'oid-stored-john';

function build_container(fault: GraphOutageFault): {
  container: Container;
  sync_mailbox: ReturnType<typeof vi.fn>;
  list_snapshot_summaries: ReturnType<typeof vi.fn>;
} {
  const request = { option: () => request, select: () => ({ get: fault.send }) };
  const client = { api: () => request } as unknown as Client;
  const repo = new InMemoryIdentityRegistryRepository({
    tenant_id: TENANT,
    entries: [
      {
        object_id: STORED_ID,
        email: ADDRESS,
        display_name: 'John Doe',
        registered_at: '2026-01-01T00:00:00.000Z',
        status: 'active',
      },
    ],
  });
  const create = vi.fn(async () => ({ destroy: vi.fn() }) as unknown as TenantContext);
  const factory: TenantContextFactory = {
    create,
    create_readonly: create,
    create_storage_only: create,
  };
  const resolver = new CachingIdentityResolver(
    new GraphUserIdentityResolver(client),
    repo,
    factory,
    { tenant_id: TENANT },
  );
  const sync_mailbox = vi.fn();
  const list_snapshot_summaries = vi.fn().mockResolvedValue([]);
  const container = new Container();
  container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: TENANT });
  container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue(resolver);
  container.bind(BACKUP_USE_CASE_TOKEN).toConstantValue({ sync_mailbox });
  container.bind(CATALOG_USE_CASE_TOKEN).toConstantValue({ list_snapshot_summaries });
  return { container, sync_mailbox, list_snapshot_summaries };
}

describe('owner lookup during a Graph outage', () => {
  let warnings: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    warnings = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ends a backup on the first exhausted budget, before the run starts', async () => {
    const fault = new GraphOutageFault();
    const { container, sync_mailbox } = build_container(fault);

    const backup = execute_outlook_backup(container, { mailbox: ADDRESS }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    expect(await backup).toBeInstanceOf(GraphUnavailableError);
    expect(fault.requests).toBe(ATTEMPTS_PER_RETRY_CHAIN);
    expect(sync_mailbox).not.toHaveBeenCalled();
    expect(warnings.join('\n')).not.toContain('Using the identity registry entry');
  });

  it('lists a known mailbox from the registry once the bounded wait elapses', async () => {
    const fault = new GraphOutageFault();
    const { container, list_snapshot_summaries } = build_container(fault);

    const listing = execute_outlook_list(container, { mailbox: ADDRESS });
    await vi.advanceTimersByTimeAsync(STORED_BACKUPS_GRAPH_WAIT_MS);
    await listing;

    expect(list_snapshot_summaries).toHaveBeenCalledWith(TENANT, STORED_ID);
    expect(fault.requests).toBeLessThan(ATTEMPTS_PER_RETRY_CHAIN);
    expect(warnings.join('\n')).toContain(`Using the identity registry entry ${STORED_ID}`);
  });
});
