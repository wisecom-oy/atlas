/**
 * `@wisecom/atlas-sdk/contract`: the rules an application must apply outside an SDK call to work
 * with Atlas, such as validating a passphrase in a browser form or keying a SharePoint inventory
 * in a Worker.
 *
 * Every export is the binding Atlas enforces with, re-exported rather than copied, so the
 * published value and the enforced value cannot drift (issue #824). The modules behind it import
 * nothing, which keeps this entry free of Node built-ins and third-party packages; a unit test
 * bundles it for a browser and fails on any import that survives.
 */
export {
  MIN_PASSPHRASE_BYTES,
  passphrase_byte_length as passphraseByteLength,
  is_acceptable_passphrase as isAcceptablePassphrase,
} from '@wisecom/atlas-core/services/keys/passphrase-floor';
export {
  tenant_bucket_name as tenantBucketName,
  is_valid_bucket_name as isValidBucketName,
} from '@wisecom/atlas-core/utils/bucket-name';
export { canonical_site_id as canonicalSiteId } from '@wisecom/atlas-types/domain/sharepoint/site-id';
export { GRAPH_SERVICE_POOLS } from '@wisecom/atlas-types/domain/graph/service-pools';
export type { GraphServicePool } from '@wisecom/atlas-types/domain/graph/service-pools';
