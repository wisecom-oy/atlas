import { inject, injectable } from 'inversify';
import type {
  IdentityRegistryEntry,
  IdentityRegistryRepository,
  ResolvedUserIdentity,
  TenantContextFactory,
  UserIdentityResolver,
} from '@atlas/types';
import { IDENTITY_REGISTRY_REPOSITORY_TOKEN, TENANT_CONTEXT_FACTORY_TOKEN } from '@atlas/types';
import { logger } from '@atlas/core/utils/logger';

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
 */
@injectable()
export class CachingIdentityResolver implements UserIdentityResolver {
  private _active_by_email = new Map<string, IdentityRegistryEntry>();
  private _by_object_id = new Map<string, IdentityRegistryEntry>();
  private _all_entries: IdentityRegistryEntry[] = [];
  private _tenant_id: string | undefined;
  private _loaded = false;

  constructor(
    @inject(GRAPH_IDENTITY_RESOLVER_TOKEN)
    private readonly _graph: UserIdentityResolver,
    @inject(IDENTITY_REGISTRY_REPOSITORY_TOKEN)
    private readonly _registry_repo: IdentityRegistryRepository,
    @inject(TENANT_CONTEXT_FACTORY_TOKEN)
    private readonly _ctx_factory: TenantContextFactory,
  ) {}

  async resolve_user(tenant_id: string, email: string): Promise<ResolvedUserIdentity> {
    await this.ensure_loaded(tenant_id);
    const normalized = email.toLowerCase().trim();

    const graph_result = await this.try_graph_resolve(tenant_id, email);

    if (graph_result) {
      const active = this._active_by_email.get(normalized);
      if (active && active.object_id !== graph_result.object_id) {
        await this.handle_recycled_email(tenant_id, active, graph_result);
      } else if (!active) {
        await this.register_new_entry(tenant_id, graph_result);
      }
      return graph_result;
    }

    const active = this._active_by_email.get(normalized);
    if (active) {
      logger.debug(`User ${email} not found in Graph, using cached identity`);
      return {
        object_id: active.object_id,
        display_name: active.display_name,
        email: active.email,
      };
    }

    throw new Error(
      `Cannot resolve "${email}": user not found in Microsoft Graph and no cached identity exists. ` +
        'The user may have never been backed up.',
    );
  }

  async resolve_users(tenant_id: string, emails: string[]): Promise<ResolvedUserIdentity[]> {
    const results: ResolvedUserIdentity[] = [];
    for (const e of emails) {
      results.push(await this.resolve_user(tenant_id, e));
    }
    return results;
  }

  async resolve_by_object_id(
    tenant_id: string,
    object_id: string,
  ): Promise<ResolvedUserIdentity | undefined> {
    await this.ensure_loaded(tenant_id);
    const cached = this._by_object_id.get(object_id);
    if (cached) {
      return {
        object_id: cached.object_id,
        display_name: cached.display_name,
        email: cached.email,
      };
    }
    return this._graph.resolve_by_object_id(tenant_id, object_id);
  }

  private async try_graph_resolve(
    tenant_id: string,
    email: string,
  ): Promise<ResolvedUserIdentity | undefined> {
    try {
      return await this._graph.resolve_user(tenant_id, email);
    } catch {
      return undefined;
    }
  }

  private async handle_recycled_email(
    tenant_id: string,
    old_entry: IdentityRegistryEntry,
    new_identity: ResolvedUserIdentity,
  ): Promise<void> {
    logger.warn(
      `Email recycling detected: "${old_entry.email}" now belongs to ` +
        `${new_identity.object_id} (was ${old_entry.object_id}). ` +
        `Old entry marked as recycled.`,
    );

    const recycled: IdentityRegistryEntry = { ...old_entry, status: 'recycled' };
    this.replace_entry(old_entry.object_id, recycled);
    this._active_by_email.delete(old_entry.email.toLowerCase().trim());

    await this.register_new_entry(tenant_id, new_identity);
  }

  private async register_new_entry(
    tenant_id: string,
    identity: ResolvedUserIdentity,
  ): Promise<void> {
    const entry: IdentityRegistryEntry = {
      object_id: identity.object_id,
      email: identity.email.toLowerCase().trim(),
      display_name: identity.display_name,
      registered_at: new Date().toISOString(),
      status: 'active',
    };
    this._all_entries.push(entry);
    this._active_by_email.set(entry.email, entry);
    this._by_object_id.set(entry.object_id, entry);

    await this.persist(tenant_id);
    logger.info(`Identity registered: ${entry.email} -> ${entry.object_id}`);
  }

  private replace_entry(object_id: string, updated: IdentityRegistryEntry): void {
    const idx = this._all_entries.findIndex((e) => e.object_id === object_id);
    if (idx >= 0) this._all_entries[idx] = updated;
    this._by_object_id.set(object_id, updated);
  }

  private async persist(tenant_id: string): Promise<void> {
    const ctx = await this._ctx_factory.create(tenant_id);
    await this._registry_repo.save(ctx, { tenant_id, entries: this._all_entries });
  }

  private async ensure_loaded(tenant_id: string): Promise<void> {
    if (this._loaded && this._tenant_id === tenant_id) return;
    const ctx = await this._ctx_factory.create(tenant_id);
    const registry = await this._registry_repo.load(ctx);
    this._active_by_email.clear();
    this._by_object_id.clear();
    this._all_entries = [];

    if (registry) {
      this._all_entries = [...registry.entries];
      for (const entry of registry.entries) {
        this._by_object_id.set(entry.object_id, entry);
        if (entry.status === 'active') {
          this._active_by_email.set(entry.email.toLowerCase().trim(), entry);
        }
      }
    }

    this._tenant_id = tenant_id;
    this._loaded = true;
  }
}
