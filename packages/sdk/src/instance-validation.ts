import { HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import type { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';
import type { Container } from 'inversify';
import { GRAPH_AUTH_PROVIDER_TOKEN } from '@wisecom/atlas-m365-graph';
import { S3_CLIENT_TOKEN, tenant_bucket_name } from '@wisecom/atlas-s3';
import {
  AtlasError,
  AuthError,
  NotFoundError,
  StorageError,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import type { TenantContextFactory } from '@wisecom/atlas-types';

/** Checks bucket access, the existing wrapped key when present, then Graph token issuance. */
export async function validate_instance(container: Container, tenant_id: string): Promise<void> {
  await validate_bucket_access(container, tenant_id);
  await validate_existing_passphrase(container, tenant_id);
  await validate_graph_token(container);
}

async function validate_bucket_access(container: Container, tenant_id: string): Promise<void> {
  try {
    const client = container.get<S3Client>(S3_CLIENT_TOKEN);
    await client.send(new HeadBucketCommand({ Bucket: tenant_bucket_name(tenant_id) }));
  } catch (cause) {
    throw new StorageError(
      'S3 validation failed. Check the endpoint, region, credentials and tenant-bucket access. ' +
        'If the tenant bucket does not exist, provision it before validating.',
      { cause },
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
    if (cause instanceof AtlasError) throw cause;
    throw new StorageError(
      'Encryption-key validation failed while reading the existing wrapped data key.',
      { cause },
    );
  }
}

async function validate_graph_token(container: Container): Promise<void> {
  try {
    const auth_provider =
      container.get<TokenCredentialAuthenticationProvider>(GRAPH_AUTH_PROVIDER_TOKEN);
    await auth_provider.getAccessToken();
  } catch (cause) {
    throw new AuthError(
      'Graph token validation failed. Check the tenant ID, client ID, client secret and ' +
        'connectivity to Microsoft Entra ID.',
      { cause },
    );
  }
}
