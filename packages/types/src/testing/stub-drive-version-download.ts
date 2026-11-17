/**
 * Returns a `download_file_version` implementation for drive connector mocks in unit tests.
 *
 * The version store checks the downloaded length against the size Graph listed for the version
 * (issue #616), so a stub that returns a fixed buffer fails every version whose fixture size
 * differs. This one returns exactly `size_bytes` bytes of `fill`, which is what a complete
 * download looks like.
 */
export function stub_drive_version_download(
  fill = 'version',
): (drive_id: string, item_id: string, version_id: string, size_bytes?: number) => Promise<Buffer> {
  return async (_drive_id, _item_id, _version_id, size_bytes = 0) =>
    await Promise.resolve(Buffer.alloc(size_bytes, fill));
}
