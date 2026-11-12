import type {
  LeaseableContext,
  OwnerLeases,
  OwnerLeaseScope,
  TenantLeaseOperation,
} from '@/ports/shared/owner-lease.port';

/** An OwnerLeases stub that always grants the lease and records what was leased. */
export interface StubOwnerLeases {
  readonly leases: OwnerLeases;
  /** Owner scopes leased, in call order. `when_writable` marks the restore variant. */
  readonly owner_scopes: ReadonlyArray<OwnerLeaseScope & { readonly when_writable: boolean }>;
  /** Tenant operations leased, in call order. */
  readonly tenant_operations: readonly TenantLeaseOperation[];
}

/**
 * Builds an OwnerLeases stub that runs every callback with the context it was given. Service tests
 * that are not about leasing use it so their storage assertions see only the service's own I/O.
 */
export function stub_owner_leases(): StubOwnerLeases {
  const owner_scopes: Array<OwnerLeaseScope & { when_writable: boolean }> = [];
  const tenant_operations: TenantLeaseOperation[] = [];
  const leases: OwnerLeases = {
    run_exclusive: <C extends LeaseableContext, T>(
      ctx: C,
      scope: OwnerLeaseScope,
      run: (leased: C) => Promise<T>,
    ): Promise<T> => {
      owner_scopes.push({ ...scope, when_writable: false });
      return run(ctx);
    },
    run_exclusive_when_writable: <C extends LeaseableContext, T>(
      ctx: C,
      scope: OwnerLeaseScope,
      run: (leased: C) => Promise<T>,
    ): Promise<T> => {
      owner_scopes.push({ ...scope, when_writable: true });
      return run(ctx);
    },
    run_tenant_exclusive: <C extends LeaseableContext, T>(
      ctx: C,
      operation: TenantLeaseOperation,
      run: (leased: C) => Promise<T>,
    ): Promise<T> => {
      tenant_operations.push(operation);
      return run(ctx);
    },
  };
  return { leases, owner_scopes, tenant_operations };
}
