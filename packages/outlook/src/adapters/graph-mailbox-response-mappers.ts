import type { MailFolder, MessageAttachment } from '@atlas/types';
import type { TenantMailbox } from '@atlas/types';
import { logger } from '@atlas/core/utils/logger';

const EXCLUDED_FOLDERS = new Set(['drafts', 'outbox', 'recoverableitemsdeletions', 'junkemail']);

export interface GraphAssignedPlan {
  service?: string;
  servicePlanId?: string;
  capabilityStatus?: string;
  assignedDateTime?: string;
}

export interface GraphUserRecord {
  id?: string;
  mail?: string;
  displayName?: string;
  createdDateTime?: string;
  assignedPlans?: GraphAssignedPlan[];
}

export interface GraphFolderRecord {
  id?: string;
  displayName?: string;
  parentFolderId?: string;
  totalItemCount?: number;
}

export interface GraphAttachmentRecord {
  '@odata.type'?: string;
  id?: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentBytes?: string;
  contentId?: string;
}

/** Extracts non-null user IDs from Graph user records. */
export function extract_user_ids(users: GraphUserRecord[]): string[] {
  return users.filter((u) => u.id).map((u) => u.id!);
}

/** Filters out excluded system folders and maps to our MailFolder type. */
export function filter_and_map_folders(folders: GraphFolderRecord[]): MailFolder[] {
  return folders
    .filter((f) => f.id && !EXCLUDED_FOLDERS.has((f.displayName ?? '').toLowerCase()))
    .map((f) => ({
      folder_id: f.id!,
      display_name: f.displayName ?? '',
      parent_folder_id: f.parentFolderId ?? undefined,
      total_item_count: f.totalItemCount ?? 0,
    }));
}

/** Extracts Exchange Online license status from a user's assignedPlans. */
export function extract_exchange_license_status(plans?: GraphAssignedPlan[]): {
  has_license: boolean;
  status?: string;
} {
  if (!plans || plans.length === 0) return { has_license: false };
  const exchange_plan = plans.find(
    (p) => p.service?.toLowerCase() === 'exchange' && p.capabilityStatus,
  );
  if (!exchange_plan) return { has_license: false };
  const enabled = exchange_plan.capabilityStatus === 'Enabled';
  const status = exchange_plan.capabilityStatus;
  return {
    has_license: enabled,
    ...(status !== undefined ? { status } : {}),
  };
}

/** Maps Graph user records to TenantMailbox objects with license information. */
export function map_users_to_tenant_mailboxes(users: GraphUserRecord[]): TenantMailbox[] {
  return users
    .filter((u) => u.id && u.mail)
    .map((u) => {
      const license = extract_exchange_license_status(u.assignedPlans);
      return {
        user_id: u.id!,
        mail: u.mail!,
        display_name: u.displayName ?? '',
        has_exchange_license: license.has_license,
        ...(license.status !== undefined ? { exchange_plan_status: license.status } : {}),
        ...(u.createdDateTime ? { created_at: new Date(u.createdDateTime) } : {}),
      };
    });
}

/** Filters to fileAttachment, decodes base64 content, warns on missing bytes. */
export function map_file_attachments(records: GraphAttachmentRecord[]): MessageAttachment[] {
  const results: MessageAttachment[] = [];

  for (const r of records) {
    if (r['@odata.type'] !== '#microsoft.graph.fileAttachment') continue;

    if (!r.contentBytes) {
      logger.warn(
        `Attachment "${r.name ?? '?'}" (${r.size ?? 0} bytes) has no contentBytes -- ` +
          `likely exceeds Graph API inline limit (>4MB). Metadata recorded, binary skipped.`,
      );
      results.push({
        attachment_id: r.id ?? '',
        name: r.name ?? '',
        content_type: r.contentType ?? 'application/octet-stream',
        size_bytes: r.size ?? 0,
        is_inline: r.isInline === true,
        content: Buffer.alloc(0),
        content_id: r.contentId ?? '',
      });
      continue;
    }

    results.push({
      attachment_id: r.id ?? '',
      name: r.name ?? '',
      content_type: r.contentType ?? 'application/octet-stream',
      size_bytes: r.size ?? 0,
      is_inline: r.isInline === true,
      content: Buffer.from(r.contentBytes, 'base64'),
      content_id: r.contentId ?? '',
    });
  }

  return results;
}
