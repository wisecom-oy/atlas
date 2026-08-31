import type { MailboxPurpose, MessageAttachment } from '@wisecom/atlas-types';
import type { TenantMailbox } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';

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
  childFolderCount?: number;
  /** Exchange hides the folder from Outlook; only returned with includeHiddenFolders. */
  isHidden?: boolean;
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
  /** Present on referenceAttachment: the cloud location the link points at. */
  sourceUrl?: string;
}

/** Extracts non-null user IDs from Graph user records. */
export function extract_user_ids(users: GraphUserRecord[]): string[] {
  return users.filter((u) => u.id).map((u) => u.id!);
}

const KNOWN_PURPOSES: readonly MailboxPurpose[] = [
  'user',
  'linked',
  'shared',
  'room',
  'equipment',
  'others',
];

/** Normalizes a Graph userPurpose value; unknown strings (e.g. unknownFutureValue) map to 'others'. */
export function parse_mailbox_purpose(value: unknown): MailboxPurpose | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  return (KNOWN_PURPOSES as readonly string[]).includes(value)
    ? (value as MailboxPurpose)
    : 'others';
}

/* Folder filtering and mapping lives in graph-folder-tree-enumerator.ts, which
   needs the whole hierarchy in hand to resolve each folder's path. */

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
