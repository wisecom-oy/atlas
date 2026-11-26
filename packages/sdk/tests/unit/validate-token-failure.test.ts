/**
 * Issue #872: `validate()` reported every failed Graph token request as `AuthError`
 * (`ATLAS_AUTH_DENIED`), so a host that probes reachability with it read a Microsoft Entra ID outage
 * as broken credentials. A refusal stays `AuthError`; a transient failure is `GraphUnavailableError`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Container } from 'inversify';
import type * as M365Graph from '@wisecom/atlas-m365-graph';
import { GraphTokenRequestError } from '@wisecom/atlas-m365-graph';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { AuthError, GraphUnavailableError, NotFoundError } from '@wisecom/atlas-types';
import { createAtlasInstance } from '@/atlas-instance.adapter';
import { create_tenant } from '@/target-tenant';

const mocks = vi.hoisted(() => ({
  get_access_token: vi.fn(),
  create_readonly_context: vi.fn(),
}));

vi.mock('@/container', async () => {
  const s3 = await import('@wisecom/atlas-s3');
  return {
    create_container_from_config: (config: AtlasConfig) => ({
      get: (token: symbol) => {
        switch (token.description) {
          case 'BucketNameResolver':
            return new s3.ConfiguredBucketNameResolver(config.s3_bucket);
          case 'S3Client':
            return { send: async () => ({}) };
          case 'GraphAuthProvider':
            return { getAccessToken: mocks.get_access_token };
          case 'TenantContextFactory':
            return { create_readonly: mocks.create_readonly_context };
          default:
            return {};
        }
      },
    }),
  };
});

vi.mock('@wisecom/atlas-m365-graph', async (load) => {
  const actual = await load<typeof M365Graph>();
  return {
    ...actual,
    bind_graph_client: (container: Container) =>
      container
        .bind(actual.GRAPH_AUTH_PROVIDER_TOKEN)
        .toConstantValue({ getAccessToken: mocks.get_access_token }),
  };
});

function instance_validate(): Promise<void> {
  return createAtlasInstance({
    tenantId: 'tenant-example',
    clientId: 'client-example',
    clientSecret: '<redacted>',
    s3Endpoint: 'https://storage.example.com',
    s3AccessKey: '<redacted>',
    s3SecretKey: '<redacted>',
    encryptionPassphrase: '<redacted>'.repeat(2),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }).validate();
}

function tenant_validate(): Promise<void> {
  return create_tenant({
    tenantId: 'contoso.onmicrosoft.com',
    clientId: '00000000-0000-0000-0000-000000000002',
    clientSecret: '<redacted>',
  }).validate();
}

/** Entra ID refused the credentials: what `TypedTokenAuthProvider` throws for a 401. */
function refused_token_request(): GraphTokenRequestError {
  const refusal = new AuthError('Microsoft Entra ID refused the Graph token request: HTTP 401');
  return new GraphTokenRequestError(refusal.message, {
    cause: refusal,
    entra_status: 401,
    transient: false,
  });
}

/** Entra ID could not answer: what `TypedTokenAuthProvider` throws for a 503 or no response. */
function transient_token_request(entra_status: number | undefined): GraphTokenRequestError {
  return new GraphTokenRequestError('Microsoft Entra ID did not issue a Graph token', {
    cause: new Error(entra_status === undefined ? 'network_error' : `HTTP ${entra_status}`),
    entra_status,
    transient: true,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.create_readonly_context.mockRejectedValue(new NotFoundError('No backups found'));
});

describe.each([
  ['atlas.validate()', instance_validate],
  ['createTenant(...).validate()', tenant_validate],
])('%s on a failed Graph token request', (_label, validate) => {
  it('rejects with AuthError when Microsoft Entra ID refused the credentials', async () => {
    const cause = refused_token_request();
    mocks.get_access_token.mockRejectedValue(cause);

    const error = await validate().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ code: 'ATLAS_AUTH_DENIED', cause });
  });

  it.each([
    ['a 503', 503],
    ['a 429', 429],
    ['a 408', 408],
    ['no response', undefined],
  ])('rejects with GraphUnavailableError after %s', async (_answer, entra_status) => {
    const cause = transient_token_request(entra_status);
    mocks.get_access_token.mockRejectedValue(cause);

    const error = await validate().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(GraphUnavailableError);
    expect(error).not.toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ code: 'ATLAS_GRAPH_UNAVAILABLE', cause });
    expect((error as Error).message).toMatch(/^Microsoft Entra ID did not issue a Graph token/);
  });

  it('rejects with GraphUnavailableError when the network failed before Entra ID answered', async () => {
    const cause = Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' });
    mocks.get_access_token.mockRejectedValue(cause);

    const error = await validate().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(GraphUnavailableError);
    expect(error).toMatchObject({ cause });
  });

  it('keeps AuthError for a failure it cannot classify', async () => {
    const cause = new Error('unexpected credential failure');
    mocks.get_access_token.mockRejectedValue(cause);

    const error = await validate().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ cause });
  });
});
