import { HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import type { AuthenticationProvider } from '@microsoft/microsoft-graph-client';
import type { Container } from 'inversify';
import { GRAPH_AUTH_PROVIDER_TOKEN } from '@wisecom/atlas-m365-graph';
import { invalid_bucket_name_error, S3_CLIENT_TOKEN } from '@wisecom/atlas-s3';
import {
  AtlasError,
  AuthError,
  BUCKET_NAME_RESOLVER_TOKEN,
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

/** Requests a Graph token through the container's auth provider; throws `AuthError` on refusal. */
export async function validate_graph_token(container: Container): Promise<void> {
  try {
    const auth_provider = container.get<AuthenticationProvider>(GRAPH_AUTH_PROVIDER_TOKEN);
    await auth_provider.getAccessToken();
  } catch (cause) {
    throw new AuthError(
      'Graph token validation failed. Check the tenant ID, client ID, client secret and ' +
        'connectivity to Microsoft Entra ID.',
      { cause },
    );
  }
}
