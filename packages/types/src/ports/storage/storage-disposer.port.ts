/**
 * Releases the resources one storage adapter holds: socket pools, cached
 * bucket state, anything else bound to a live endpoint.
 *
 * A port rather than a direct call, so the SDK can tear an instance down
 * without importing the S3 adapter and knowing what is inside it (issue #42).
 */
export type StorageDisposer = () => Promise<void>;
