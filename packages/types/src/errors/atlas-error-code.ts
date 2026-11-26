/**
 * Stable machine-readable codes. The string values are the contract: they are safe to switch on,
 * to log, and to compare across versions. Prose messages are not, and never were.
 */
export type AtlasErrorCode =
  | 'ATLAS_AUTH_DENIED'
  | 'ATLAS_MAILBOX_NOT_LICENSED'
  | 'ATLAS_NOT_FOUND'
  | 'ATLAS_THROTTLED'
  | 'ATLAS_WRONG_PASSPHRASE'
  | 'ATLAS_OBJECT_LOCK_RETAINED'
  | 'ATLAS_STORAGE_FAILURE'
  | 'ATLAS_CONTENT_UNREADABLE'
  | 'ATLAS_FORMAT_UNSUPPORTED'
  | 'ATLAS_SNAPSHOT_NOT_NEWEST'
  | 'ATLAS_WRITE_REFUSED'
  | 'ATLAS_OWNER_BUSY'
  | 'ATLAS_CONFIG_INVALID'
  | 'ATLAS_ACCESS_REFUSED'
  | 'ATLAS_GRAPH_UNAVAILABLE'
  | 'ATLAS_STORAGE_UNAVAILABLE'
  | 'ATLAS_LISTING_INCOMPLETE';
