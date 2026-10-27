// Mock CLI runs for the docs terminal (hero-terminal.vue). Line formats follow packages/cli:
// Banner, KeyValueList (labels padded to the longest), DataTable (two-space gaps, dashed rule),
// logger prefixes ([*] info, [+] success) and ResultSummary. The CLI's ` -- ` separators are
// written as `:` and `,`, because the site's prose rule bars dash punctuation. All data is fake.

export type TerminalLine = { text: string; cls?: string; delay: number };
export type TerminalSession = { command: string; lines: TerminalLine[] };

const TENANT = '00000000-aaaa-4bbb-8ccc-000000000000';
const SNAPSHOT = 'snap-1761555312000-a3f9c1';

/** A KeyValueList block: `Label:` padded to the longest label plus one space. */
function key_values(items: [string, string][], delay = 120): TerminalLine[] {
  const width = Math.max(...items.map(([label]) => label.length)) + 2;
  return items.map(([label, value], i) => ({
    text: `${label}:`.padEnd(width) + value,
    delay: i === 0 ? delay : 60,
  }));
}

const banner = (title: string): TerminalLine => ({ text: title, cls: 'banner', delay: 250 });

export const OUTLOOK_BACKUP: TerminalSession = {
  command: 'atlas outlook backup -m user@example.com',
  lines: [
    banner('Atlas · Outlook Backup'),
    ...key_values([
      ['Tenant', TENANT],
      ['Mailbox', 'user@example.com'],
    ]),
    { text: '  [ok] Inbox: 128 stored, 14 dedup', cls: 'ok', delay: 700 },
    { text: '  [ok] Sent Items: 42 stored, 3 dedup', cls: 'ok', delay: 500 },
    { text: '  [==] Archive: 2310 items, up to date', cls: 'muted', delay: 400 },
    { text: '  [ok] Projects/2026: 61 stored, 9 dedup', cls: 'ok', delay: 500 },
    { text: '  [--] Junk Email: 0 items, empty', cls: 'muted', delay: 300 },
    { text: '[*] Resuming incremental sync from saved delta state', cls: 'info', delay: 350 },
    { text: '231 stored | 26 dedup | 48 attachments | 0 errors | 9.2s', cls: 'bold', delay: 300 },
    { text: `[+] Snapshot ${SNAPSHOT}: 2,617 objects, 1.4 GB`, cls: 'ok', delay: 300 },
  ],
};

const CONFIG_VALIDATE: TerminalSession = {
  command: 'atlas config validate',
  lines: [
    {
      text: '[+] Microsoft Graph: token acquired (tenant and credentials valid)',
      cls: 'ok',
      delay: 900,
    },
    { text: '[+] S3: endpoint reachable and credentials accepted', cls: 'ok', delay: 500 },
  ],
};

const OUTLOOK_LIST: TerminalSession = {
  command: 'atlas outlook list -m user@example.com',
  lines: [
    banner('Atlas · Outlook List'),
    ...key_values([['Tenant', TENANT]]),
    { text: '[*] 2 snapshot(s) for user@example.com', cls: 'info', delay: 400 },
    { text: '', delay: 0 },
    { text: 'Snapshot                   Objects  Size    Created', cls: 'bold', delay: 150 },
    {
      text: '-------------------------  -------  ------  -------------------',
      cls: 'muted',
      delay: 0,
    },
    { text: `${SNAPSHOT}  2617     1.4 GB  2025-10-27 08:55:12`, delay: 80 },
    { text: 'snap-1761468901000-7be210  2386     1.3 GB  2025-10-26 08:55:01', delay: 80 },
  ],
};

const OUTLOOK_VERIFY: TerminalSession = {
  command: `atlas outlook verify -m user@example.com -s ${SNAPSHOT}`,
  lines: [
    banner('Atlas · Outlook Verify'),
    ...key_values([['Mailbox', 'user@example.com']]),
    { text: `[*] Verifying snapshot ${SNAPSHOT}...`, cls: 'info', delay: 300 },
    {
      text: '[*] Verified merged state across 2 manifest(s) in the chain',
      cls: 'info',
      delay: 1400,
    },
    { text: '[+] All 2617 objects passed integrity check', cls: 'ok', delay: 300 },
  ],
};

const STORAGE_CHECK: TerminalSession = {
  command: 'atlas storage-check',
  lines: [
    banner('Atlas · Storage Check'),
    ...key_values(
      [
        ['Bucket', `atlas-${TENANT}`],
        ['Reachable', 'yes'],
        ['Versioning', 'enabled'],
        ['Object Lock', 'enabled'],
        ['Bucket class', 'lock-capable'],
        ['Governance mode', 'supported'],
        ['Compliance mode', 'supported'],
        ['Status', 'ready'],
      ],
      500,
    ),
  ],
};

/** Getting started: the commands in the order the guide runs them. */
export const GETTING_STARTED: TerminalSession[] = [
  CONFIG_VALIDATE,
  OUTLOOK_BACKUP,
  OUTLOOK_LIST,
  OUTLOOK_VERIFY,
  STORAGE_CHECK,
];
