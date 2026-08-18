/**
 * Reads a mailbox's snapshots through the published SDK bundle and prints their ids as JSON.
 *
 * The point is the packaging boundary, not the logic: the CLI and the SDK are separate published
 * artifacts, and the SDK is the one consumers embed. A build that ships a CLI which works and an
 * SDK bundle that cannot even be imported is a release nobody would notice until an integrator
 * files an issue -- so this loads `dist/index.mjs`, the file that goes to npm.
 *
 * Output is ids only. Manifests carry subjects and file names; those must never reach a public log.
 */

import { createAtlasInstance } from '../packages/sdk/dist/index.mjs';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const atlas = createAtlasInstance({
  tenantId: required('ATLAS_TENANT_ID'),
  clientId: required('ATLAS_CLIENT_ID'),
  clientSecret: required('ATLAS_CLIENT_SECRET'),
  s3Endpoint: required('ATLAS_S3_ENDPOINT'),
  s3AccessKey: required('ATLAS_S3_ACCESS_KEY'),
  s3SecretKey: required('ATLAS_S3_SECRET_KEY'),
  s3Region: process.env.ATLAS_S3_REGION ?? 'us-east-1',
  encryptionPassphrase: required('ATLAS_ENCRYPTION_PASSPHRASE'),
});

const snapshots = await atlas.outlook.listSnapshots(required('E2E_MAILBOX'));
process.stdout.write(JSON.stringify(snapshots.map((manifest) => manifest.snapshot_id)));
