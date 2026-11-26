import type {
  OwnerExclusion,
  OwnerExclusionRequest,
  OwnerExclusionResult,
  OwnerLeaseOperation,
} from '@wisecom/atlas-types';

/** The key the tenant-wide scope is held under, next to `<workload>/<owner id>` keys. */
const TENANT_SCOPE = 'tenant';

/**
 * The exclusion the CLI's single-writer mode uses (issue #974). It keeps the storage lease's rules
 * inside one process: one operation per owner, and a tenant scope that excludes every owner of the
 * tenant. Other processes are not seen at all; keeping them off the tenant is the operator's part.
 */
export class InProcessOwnerExclusion implements OwnerExclusion {
  /** Held scopes per tenant, each with the operation that holds it. */
  private readonly _held = new Map<string, Map<string, OwnerLeaseOperation>>();

  /** Grants the scope unless a conflicting scope of the same tenant is held in this process. */
  async acquire(request: OwnerExclusionRequest): Promise<OwnerExclusionResult> {
    const scopes = this._held.get(request.tenantId) ?? new Map<string, OwnerLeaseOperation>();
    const conflict = find_conflicting_operation(scopes, request);
    if (conflict !== undefined) return { acquired: false, heldByOperation: conflict };
    const scope = scope_key(request);
    scopes.set(scope, request.operation);
    this._held.set(request.tenantId, scopes);
    let released = false;
    return {
      acquired: true,
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        this.forget(request.tenantId, scope);
      },
    };
  }

  private forget(tenant_id: string, scope: string): void {
    const scopes = this._held.get(tenant_id);
    scopes?.delete(scope);
    if (scopes?.size === 0) this._held.delete(tenant_id);
  }
}

/**
 * The operation that blocks `request`: any held scope blocks the tenant scope, and the tenant scope
 * or the same owner blocks an owner scope.
 */
function find_conflicting_operation(
  scopes: ReadonlyMap<string, OwnerLeaseOperation>,
  request: OwnerExclusionRequest,
): OwnerLeaseOperation | undefined {
  if (request.workload === 'tenant') return scopes.values().next().value;
  return scopes.get(TENANT_SCOPE) ?? scopes.get(scope_key(request));
}

function scope_key(request: OwnerExclusionRequest): string {
  return request.workload === 'tenant' ? TENANT_SCOPE : `${request.workload}/${request.ownerId}`;
}
