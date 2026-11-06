import { ListBucketsCommand } from '@aws-sdk/client-s3';
import { ClientSecretCredential } from '@azure/identity';
import type { GraphConfig, S3Config } from '@wisecom/atlas-core';
import { logger } from '@wisecom/atlas-core';
import { create_s3_client } from '@wisecom/atlas-s3';

const GRAPH_FIELDS = ['tenant_id', 'client_id', 'client_secret'] as const;
const S3_FIELDS = ['s3_endpoint', 's3_access_key', 's3_secret_key'] as const;

/**
 * Requests a Graph token with the client credentials; logs the outcome. The optional profile
 * name is put in the log lines so a validate run over several profiles stays readable.
 */
export async function probe_graph(
  config: Partial<GraphConfig>,
  profile?: string,
): Promise<boolean> {
  const label = profile === undefined ? 'Microsoft Graph' : `Microsoft Graph [${profile}]`;
  if (!GRAPH_FIELDS.every((f) => config[f] !== undefined)) {
    logger.warn(`${label}: credentials incomplete -- add them with "atlas tenants add"`);
    return false;
  }
  try {
    const credential = new ClientSecretCredential(
      config.tenant_id as string,
      config.client_id as string,
      config.client_secret as string,
    );
    await credential.getToken('https://graph.microsoft.com/.default');
    logger.success(`${label}: token acquired (tenant and credentials valid)`);
    return true;
  } catch (err) {
    logger.error(`${label} validation failed: ${(err as Error).message}`);
    return false;
  }
}

/** Lists buckets on the configured S3 endpoint; logs the outcome. */
export async function probe_s3(config: Partial<S3Config>): Promise<boolean> {
  if (!S3_FIELDS.every((f) => config[f] !== undefined)) {
    logger.warn('S3 settings incomplete -- set s3.endpoint, s3.access-key, s3.secret-key');
    return false;
  }
  const client = create_s3_client({
    s3_endpoint: config.s3_endpoint as string,
    s3_access_key: config.s3_access_key as string,
    s3_secret_key: config.s3_secret_key as string,
    s3_region: config.s3_region ?? 'us-east-1',
  });
  try {
    await client.send(new ListBucketsCommand({}));
    logger.success('S3: endpoint reachable and credentials accepted');
    return true;
  } catch (err) {
    logger.error(`S3 validation failed: ${(err as Error).message}`);
    return false;
  } finally {
    client.destroy();
  }
}
