import { create_cdn_chunk_downloader } from '@wisecom/atlas-drive/backup/cdn-chunk-download';

/** The shared CDN chunk downloader, bound to SharePoint. */
export const SHAREPOINT_CHUNK_DOWNLOADER = create_cdn_chunk_downloader('sharepoint');
