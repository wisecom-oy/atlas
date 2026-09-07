import { HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import type { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';
import type { Container } from 'inversify';
import { GRAPH_AUTH_PROVIDER_TOKEN } from '@wisecom/atlas-m365-graph';
import { S3_CLIENT_TOKEN, tenant_bucket_name } from '@wisecom/atlas-s3';
import { AuthError, StorageError } from '@wisecom/atlas-types';

/** Checks bucket access, then Graph token issuance, without provisioning storage or loading keys. */
export async function validate_instance(container: Container, tenant_id: string): Promise<void> {
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
