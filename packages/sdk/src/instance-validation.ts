import { HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import type { AuthenticationProvider } from '@microsoft/microsoft-graph-client';
import type { Container } from 'inversify';
import {
  GRAPH_AUTH_PROVIDER_TOKEN,
  is_network_error,
  is_transient_token_request_error,
  token_request_refusal,
} from '@wisecom/atlas-m365-graph';
import { invalid_bucket_name_error, S3_CLIENT_TOKEN } from '@wisecom/atlas-s3';
import {
  AtlasError,
  AuthError,
  BUCKET_NAME_RESOLVER_TOKEN,
  GraphUnavailableError,
  NotFoundError,
  StorageError,
  StorageUnavailableError,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import type { BucketNameResolver, TenantContextFactory } from '@wisecom/atlas-types';

/** Checks bucket access, the existing wrapped key when present, then Graph token issuance. */
export async function validate_instance(container: Container, tenant_id: string): Promise<void> {
  await validate_bucket_access(container, tenant_id);
  await validate_existing_passphrase(container, tenant_id);
  await validate_graph_token(container);
}

/** Sends HeadBucket to the tenant's bucket: the configured override, or `atlas-<tenantId>`. */
async function validate_bucket_access(container: Container, tenant_id: string): Promise<void> {
  const bucket = container.get<BucketNameResolver>(BUCKET_NAME_RESOLVER_TOKEN).resolve(tenant_id);
  try {
    const client = container.get<S3Client>(S3_CLIENT_TOKEN);
    await client.send(new HeadBucketCommand({ Bucket: bucket.name }));
  } catch (cause) {
    throw (
      invalid_bucket_name_error(bucket.name, cause) ??
      new StorageError(
        `S3 validation of bucket "${bucket.name}" failed. Check the endpoint, region, ` +
          'credentials and tenant-bucket access. If the tenant bucket does not exist, provision ' +
          'it before validating.',
        { cause },
      )
    );
  }
}

/**
 * Loads and unwraps the tenant's existing key without provisioning one.
 *
 * `create_readonly` is the one existing path that gets `_meta/dek.enc`, unwraps it with the
 * configured passphrase and never creates missing state. A fresh tenant has no wrapper yet and is
 * valid; any other deliberate Atlas error, especially `WrongPassphraseError`, is the result. The
 * context is destroyed immediately so neither the DEK nor derived key material outlives the check.
 */
async function validate_existing_passphrase(
  container: Container,
  tenant_id: string,
): Promise<void> {
  const tenant_factory = container.get<TenantContextFactory>(TENANT_CONTEXT_FACTORY_TOKEN);
  try {
    const ctx = await tenant_factory.create_readonly(tenant_id);
    ctx.destroy();
  } catch (cause) {
    if (cause instanceof NotFoundError) return;
    // An unanswered read is still a storage failure here: `validate()` promises `StorageError`.
    if (cause instanceof AtlasError && !(cause instanceof StorageUnavailableError)) throw cause;
    throw new StorageError(
      'Encryption-key validation failed while reading the existing wrapped data key.',
      { cause },
    );
  }
}

/**
 * Requests a Graph token through the container's auth provider (issue #872).
 *
 * Throws `AuthError` when Microsoft Entra ID refused the credentials, and `GraphUnavailableError`
 * when the token request got no response or Entra answered `408`, `429`, a `5xx` or
 * `temporarily_unavailable`, so a host can tell wrong credentials from an outage. Any other failure
 * stays `AuthError`, as before. `cause` keeps the original failure in every case.
 */
export async function validate_graph_token(container: Container): Promise<void> {
  const started_at = Date.now();
  try {
    const auth_provider = container.get<AuthenticationProvider>(GRAPH_AUTH_PROVIDER_TOKEN);
    await auth_provider.getAccessToken();
  } catch (cause) {
    throw classify_token_failure(cause, Date.now() - started_at);
  }
}

/** The error `validate()` rejects with for a failed token request. */
function classify_token_failure(cause: unknown, elapsed_ms: number): AtlasError {
  if (token_request_refusal(cause) === undefined && is_transient_token_failure(cause)) {
    return new GraphUnavailableError(
      'Microsoft Entra ID did not issue a Graph token: it was unavailable or unreachable, so ' +
        'the credentials were neither accepted nor refused. Try again later.',
      { retries: 0, elapsed_ms },
      { cause },
    );
  }
  return new AuthError(
    'Graph token validation failed. Check the tenant ID, client ID, client secret and ' +
      'connectivity to Microsoft Entra ID.',
    { cause },
  );
}

/** A token request that may succeed if repeated: no response, a 408, a 429 or a 5xx. */
function is_transient_token_failure(cause: unknown): boolean {
  return is_transient_token_request_error(cause) || is_network_error(cause);
}
