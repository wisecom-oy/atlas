import { create_cdn_chunk_downloader } from '@wisecom/atlas-drive/backup/cdn-chunk-download';

/** The shared CDN chunk downloader, bound to OneDrive. */
export const ONEDRIVE_CHUNK_DOWNLOADER = create_cdn_chunk_downloader('onedrive');
