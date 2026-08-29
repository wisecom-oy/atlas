import { writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { logger } from '@/utils/logger';

/**
 * Windows zone for content that came over the network from outside the
 * organisation. Exported mail and drive files came from a Microsoft 365
 * tenant, not from this machine and not from an intranet share.
 */
const ZONE_ID_INTERNET = 3;

const ZONE_TRANSFER_CONTENT = `[ZoneTransfer]\r\nZoneId=${ZONE_ID_INTERNET}\r\n`;

/**
 * Stamps Mark-of-the-Web on a file Atlas just wrote, on Windows only.
 *
 * An archive written by a local process carries no `Zone.Identifier` stream,
 * so everything extracted from it is unmarked too. The same content arriving
 * through a browser or a mail attachment would open in Protected View, and
 * since Office 2203 its macros would be blocked outright. Atlas does not vet
 * backed-up content and should not have to, so an export must not be the path
 * that launders that mark away.
 *
 * NTFS exposes alternate data streams as `path:stream`, which is the form
 * `CreateFileW` accepts, so this needs no dependency. It is gated on Windows
 * because elsewhere a `:` in the path is an ordinary character and would
 * create a junk file instead of a stream.
 *
 * Never throws. A filesystem without ADS support (FAT32 or exFAT removable
 * media, SMB to a non-NTFS server) rejects the write, and a recovered archive
 * is worth more than its mark.
 *
 * @param file_path Path to the archive that was just flushed and closed.
 * @returns Whether the mark was written.
 * @see https://learn.microsoft.com/en-us/microsoft-365-apps/security/internet-macros-blocked
 */
export async function mark_downloaded_from_internet(file_path: string): Promise<boolean> {
  if (platform() !== 'win32') return false;

  try {
    await writeFile(`${file_path}:Zone.Identifier`, ZONE_TRANSFER_CONTENT, 'utf-8');
    return true;
  } catch (err) {
    logger.warn(
      `Could not mark ${file_path} as downloaded from the internet ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        `Files extracted from it will not open in Protected View.`,
    );
    return false;
  }
}
