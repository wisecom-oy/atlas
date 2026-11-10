import { inject, injectable } from 'inversify';
import type {
  IdentityRegistry,
  IdentityRegistryEntry,
  IdentityRegistryRepository,
  ResolvedUserIdentity,
  TenantContext,
  TenantContextFactory,
  UserIdentityResolver,
} from '@wisecom/atlas-types';
import {
  NotFoundError,
  IDENTITY_REGISTRY_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { ATLAS_CONFIG_TOKEN, type GraphConfig } from '@/utils/config';
import {
  merge_active_identity,
  normalize_registry_email,
  type IdentityMergeOutcome,
} from '@/adapters/identity/identity-registry-merge';
import {
  build_tenant_identity_index,
  type TenantIdentityIndex,
} from '@/adapters/identity/tenant-identity-index';

export const GRAPH_IDENTITY_RESOLVER_TOKEN = Symbol.for('GraphIdentityResolver');

/**
 * Identity resolver with local S3-backed cache and email recycling detection.
 *
 * Resolution strategy:
 * 1. Try Graph API (single /users/{email} call)
 * 2. If Graph returns a known object_id -> done
 * 3. If Graph returns a NEW object_id for a cached email -> email recycled!
 *    -> Mark old entry as 'recycled', store new entry as 'active'
 * 4. If Graph returns 404 (user deleted) -> fall back to active cache entry
 *
 * Multiple entries can share the same email; only one is 'active'.
 * Old users are accessed via their object_id directly.
 *
 * Graph only speaks for the storage tenant when the configured credentials belong to it. When
 * they belong to another tenant, as in a cross-tenant restore, the registry is read-only: see
 * {@link CachingIdentityResolver.resolve_without_registering}.
 *
 * One instance serves every tenant (it is a singleton in the container), so each tenant keeps its
 * own index. A lookup reads only the index of the tenant it asked about (issue #621).
 */
@injectable()
export class CachingIdentityResolver implements UserIdentityResolver {
  /** Each tenant's index, keyed by tenant id so one tenant's load never replaces another's. */
  private readonly _indexes = new Map<string, TenantIdentityIndex>();
  /** In-flight first loads keyed by tenant id, shared by concurrent first callers. */
  private readonly _loading = new Map<string, Promise<TenantIdentityIndex>>();

  constructor(
    @inject(GRAPH_IDENTITY_RESOLVER_TOKEN)
    private readonly _graph: UserIdentityResolver,
    @inject(IDENTITY_REGISTRY_REPOSITORY_TOKEN)
    private readonly _registry_repo: IdentityRegistryRepository,
    @inject(TENANT_CONTEXT_FACTORY_TOKEN)
    private readonly _ctx_factory: TenantContextFactory,
    @inject(ATLAS_CONFIG_TOKEN)
    private readonly _config: Pick<GraphConfig, 'tenant_id'>,
  ) {}

  async resolve_user(tenant_id: string, email: string): Promise<ResolvedUserIdentity> {
    const index = await this.ensure_loaded(tenant_id);
    const normalized = normalize_registry_email(email);
    const graph_is_foreign = tenant_id.toLowerCase() !== this._config.tenant_id.toLowerCase();
    if (graph_is_foreign) {
      return this.resolve_without_registering(tenant_id, email, normalized, index);
    }

    const graph = await this.try_graph_resolve(tenant_id, email);

    if ('identity' in graph) {
      const graph_result = graph.identity;
      const active = index.active_by_email.get(normalized);
      if (active?.object_id !== graph_result.object_id) {
        await this.register_identity(tenant_id, graph_result);
      }
      return graph_result;
    }

    const active = index.active_by_email.get(normalized);
    if (active) {
      logger.debug(`User ${email} not found in Graph, using cached identity`);
      return to_identity(active);
    }

    // Only a 404 says the user is absent. A 403, throttling or an outage says Graph could not
    // answer, and reporting that as not found would send the operator after a typo.
    if ((graph.error as Record<string, unknown> | null)?.statusCode !== 404) throw graph.error;
    throw new NotFoundError(
      `Cannot resolve "${email}": user not found in Microsoft Graph and no cached identity exists. ` +
        'The user may have never been backed up.',
      { cause: graph.error },
    );
  }

  async resolve_by_object_id(
    tenant_id: string,
    object_id: string,
  ): Promise<ResolvedUserIdentity | undefined> {
    const index = await this.ensure_loaded(tenant_id);
    const cached = index.by_object_id.get(object_id);
    if (cached) return to_identity(cached);
    return this._graph.resolve_by_object_id(tenant_id, object_id);
  }

  /**
   * Resolves against a storage tenant that the Graph credentials do not belong to. Graph then
   * describes the other tenant, so the stored registry wins and Graph's answer is never written
   * back: a same-email user over there would otherwise be recorded as a recycled email and
   * repoint the address at a foreign object id (issue #591).
   */
  private async resolve_without_registering(
    tenant_id: string,
    email: string,
    normalized: string,
    index: TenantIdentityIndex,
  ): Promise<ResolvedUserIdentity> {
    const active = index.active_by_email.get(normalized);
    if (active) return to_identity(active);
    logger.warn(
      `${email} is not in the identity registry of tenant ${tenant_id}, and the configured Graph ` +
        `credentials belong to tenant ${this._config.tenant_id}. Using that tenant's answer ` +
        'without recording it; pass the Entra object ID to name a user of the backed-up tenant.',
    );
    return this._graph.resolve_user(tenant_id, email);
  }

  /**
   * Graph lookup that falls back to the cached registry, so a lookup still works while Graph is
   * unreachable. The failure is logged rather than dropped: a silent swallow here looks identical
   * to a user that genuinely does not exist (issue #202).
   */
  private async try_graph_resolve(
    tenant_id: string,
    email: string,
  ): Promise<{ identity: ResolvedUserIdentity } | { error: unknown }> {
    try {
      return { identity: await this._graph.resolve_user(tenant_id, email) };
    } catch (err) {
      logger.debug(
        `Graph could not resolve "${email}", falling back to the cached registry: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return { error: err };
    }
  }

  /**
   * Makes `identity` the active entry for its email in the stored registry, then reindexes that
   * tenant from what is stored. Merged against storage rather than this instance's copy, so a
   * registration another process made since this one loaded is kept rather than overwritten.
   */
  private async register_identity(
    tenant_id: string,
    identity: ResolvedUserIdentity,
  ): Promise<void> {
    let outcome: IdentityMergeOutcome = { kind: 'unchanged' };
    const ctx = await this._ctx_factory.create(tenant_id);
    let stored: IdentityRegistry | undefined;
    try {
      stored = await this._registry_repo.update(ctx, (current) => {
        const merged = merge_active_identity(
          current,
          tenant_id,
          identity,
          new Date().toISOString(),
        );
        outcome = merged.outcome;
        return merged.outcome.kind === 'unchanged' ? undefined : merged.registry;
      });
    } finally {
      ctx.destroy();
    }
    this._indexes.set(tenant_id, build_tenant_identity_index(stored));
    log_registration(identity, outcome);
  }

  /**
   * Reads the stored registry without provisioning: a tenant with no bucket or data key yet reads
   * as empty. Opening it writable would create both before Graph is even asked, so a mistyped
   * tenant would leave a bucket behind (issue #599). Registering an identity still provisions.
   */
  private async load_registry(tenant_id: string): Promise<IdentityRegistry | undefined> {
    let ctx: TenantContext;
    try {
      ctx = await this._ctx_factory.create_readonly(tenant_id);
    } catch (err) {
      if (err instanceof NotFoundError) return undefined;
      throw err;
    }
    try {
      return await this._registry_repo.load(ctx);
    } finally {
      ctx.destroy();
    }
  }

  /**
   * Returns the tenant's index, loading its registry on first use. Concurrent first callers for
   * one tenant share one in-flight load: two separate loads would each reset the index, and the
   * second could drop an entry the first caller had just registered. A failed load is dropped so
   * the next call retries.
   */
  private async ensure_loaded(tenant_id: string): Promise<TenantIdentityIndex> {
    const loaded = this._indexes.get(tenant_id);
    if (loaded) return loaded;
    let pending = this._loading.get(tenant_id);
    if (!pending) {
      pending = this.load_and_index(tenant_id).finally(() => this._loading.delete(tenant_id));
      this._loading.set(tenant_id, pending);
    }
    return pending;
  }

  private async load_and_index(tenant_id: string): Promise<TenantIdentityIndex> {
    const index = build_tenant_identity_index(await this.load_registry(tenant_id));
    this._indexes.set(tenant_id, index);
    return index;
  }
}

/** Strips registry bookkeeping from an entry, leaving the identity a caller asked for. */
function to_identity(entry: IdentityRegistryEntry): ResolvedUserIdentity {
  return { object_id: entry.object_id, display_name: entry.display_name, email: entry.email };
}

/** Reports what a registration changed; nothing when another writer had already made it. */
function log_registration(identity: ResolvedUserIdentity, outcome: IdentityMergeOutcome): void {
  const email = normalize_registry_email(identity.email);
  if (outcome.kind === 'recycled') {
    logger.warn(
      `Email recycling detected: "${email}" now belongs to ${identity.object_id} ` +
        `(was ${outcome.previous_object_id}). Old entry marked as recycled.`,
    );
  }
  if (outcome.kind !== 'unchanged') {
    logger.info(`Identity registered: ${email} -> ${identity.object_id}`);
  }
}
