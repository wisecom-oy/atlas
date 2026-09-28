/** Rule actions whose value is a mail folder ID. */
export const RULE_FOLDER_ACTIONS: ReadonlySet<string> = new Set(['moveToFolder', 'copyToFolder']);

/** Mailbox settings Graph accepts in `PATCH /mailboxSettings`; the rest are read-only. */
export const WRITABLE_MAILBOX_SETTINGS = [
  'automaticRepliesSetting',
  'dateFormat',
  'delegateMeetingMessageDeliveryOptions',
  'language',
  'timeFormat',
  'timeZone',
  'workingHours',
] as const;
