/** Inbox rules, master categories, and mailbox settings as Graph returns them. */
export interface MailboxConfigSource {
  readonly message_rules: Record<string, unknown>[];
  readonly master_categories: Record<string, unknown>[];
  readonly mailbox_settings: Record<string, unknown>;
}

/**
 * The stored configuration document. `rule_folder_paths` maps each folder ID a rule references
 * to its mailbox path at backup time, because folder IDs do not exist in a restore target.
 */
export interface MailboxConfigDocument extends MailboxConfigSource {
  readonly rule_folder_paths: Record<string, string>;
}

/** Manifest and cursor reference to one content-addressed configuration document. */
export interface MailboxConfigRef {
  readonly storage_key: string;
  readonly checksum: string;
  readonly size_bytes: number;
  readonly captured_at: string;
}
