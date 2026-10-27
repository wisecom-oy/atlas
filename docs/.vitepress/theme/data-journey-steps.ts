// Content of the "How your data travels" diagram. Facts follow docs/security.md and
// docs/operations/storage-layout.md; update both together.

export type NodeId =
  | 'm365'
  | 'reader'
  | 'fingerprint'
  | 'seal'
  | 'passphrase'
  | 'kek'
  | 'dek'
  | 'backups'
  | 'catalogue'
  | 'locked_key';

export type DiagramNode = {
  id: NodeId;
  x: number;
  y: number;
  w: number;
  title: string;
  sub: string;
};

/** plain: readable content, sealed: encrypted content, key: key material. */
export type PacketKind = 'plain' | 'sealed' | 'key';

export type StepEdge = { id: string; kind: PacketKind; reverse?: boolean };

export type Step = {
  title: string;
  text: string;
  detail: string;
  nodes: NodeId[];
  edges: StepEdge[];
};

export const NODES: DiagramNode[] = [
  { id: 'm365', x: 90, y: 110, w: 120, title: 'Microsoft 365', sub: 'mail and files' },
  { id: 'reader', x: 270, y: 110, w: 120, title: 'Atlas reads', sub: 'changes only' },
  { id: 'fingerprint', x: 450, y: 110, w: 120, title: 'Fingerprint', sub: 'HMAC-SHA256' },
  { id: 'seal', x: 630, y: 110, w: 120, title: 'Seal', sub: 'AES-256-GCM' },
  { id: 'passphrase', x: 270, y: 290, w: 120, title: 'Your passphrase', sub: 'only you hold it' },
  { id: 'kek', x: 450, y: 290, w: 120, title: 'Unlock key', sub: 'scrypt' },
  { id: 'dek', x: 630, y: 290, w: 120, title: 'Data key', sub: 'memory only' },
  { id: 'backups', x: 820, y: 110, w: 110, title: 'Backups', sub: 'sealed items' },
  { id: 'catalogue', x: 820, y: 200, w: 110, title: 'Catalogue', sub: 'manifest' },
  { id: 'locked_key', x: 820, y: 290, w: 110, title: 'Locked key', sub: 'dek.enc' },
];

/** SVG paths, drawn in the forward direction. */
export const EDGES: Record<string, string> = {
  'm365-reader': 'M150 110 L210 110',
  'reader-fingerprint': 'M330 110 L390 110',
  'fingerprint-seal': 'M510 110 L570 110',
  'seal-backups': 'M690 110 L765 110',
  'seal-catalogue': 'M690 120 C728 120 728 200 765 200',
  'passphrase-kek': 'M330 290 L390 290',
  'kek-dek': 'M510 290 L570 290',
  'locked_key-dek': 'M765 290 L690 290',
  'dek-seal': 'M630 265 L630 135',
  'dek-fingerprint': 'M600 265 C600 200 480 200 480 135',
};

export const STEPS: Step[] = [
  {
    title: 'Unlock the data key',
    text: 'Each organisation has one random data key, and it is never stored in readable form. The bucket holds only a locked copy. At the start of a run, Atlas turns your passphrase into an unlock key and opens the data key with it. The open key exists only in memory while Atlas runs.',
    detail:
      'scrypt (N=65536, r=8, p=1, 32-byte random salt) derives a 256-bit KEK. The KEK unwraps _meta/dek.enc with AES-256-GCM. Lose the passphrase and the backups cannot be opened by anyone.',
    nodes: ['passphrase', 'kek', 'dek', 'locked_key'],
    edges: [
      { id: 'passphrase-kek', kind: 'key' },
      { id: 'locked_key-dek', kind: 'sealed' },
      { id: 'kek-dek', kind: 'key' },
    ],
  },
  {
    title: 'Read what changed',
    text: 'Atlas asks Microsoft 365 for mail and files. The first backup copies everything. Later runs ask only for what changed since the last one, so a nightly backup moves a small fraction of the data.',
    detail:
      'Microsoft Graph delta queries. Each run saves its delta links, so the next run starts where the previous one ended.',
    nodes: ['m365', 'reader'],
    edges: [{ id: 'm365-reader', kind: 'plain' }],
  },
  {
    title: 'Fingerprint and skip duplicates',
    text: 'Every item gets a fingerprint calculated from its content and the data key. If the same content is already stored, Atlas does not upload it again. Without the data key, nobody can work out which fingerprint belongs to a file they already have.',
    detail:
      'HMAC-SHA256 over the plaintext, keyed with a naming key derived from the DEK (HKDF-SHA256). Identical content for one owner is stored once.',
    nodes: ['reader', 'fingerprint', 'dek'],
    edges: [
      { id: 'reader-fingerprint', kind: 'plain' },
      { id: 'dek-fingerprint', kind: 'key' },
    ],
  },
  {
    title: 'Seal it',
    text: 'Atlas encrypts each item with the data key before it leaves the machine. The seal also detects tampering: change a single bit and it no longer opens. Each sealed item is tied to its place in the bucket, so it cannot be swapped into another person\u2019s backup.',
    detail:
      'AES-256-GCM with a fresh random 12-byte IV per object. The header and the object\u2019s directory are authenticated as associated data.',
    nodes: ['fingerprint', 'seal', 'dek'],
    edges: [
      { id: 'fingerprint-seal', kind: 'plain' },
      { id: 'dek-seal', kind: 'key' },
    ],
  },
  {
    title: 'Store it',
    text: 'Only sealed data travels to your S3 storage. Whoever runs the storage sees sizes and random-looking names, never content. With Object Lock turned on, the storage itself refuses to delete or overwrite backups until the retention period ends, even for someone holding valid credentials.',
    detail:
      'Content-MD5 on every upload catches corruption in transit. Object Lock runs in governance or compliance mode, set with --retention-days.',
    nodes: ['seal', 'backups'],
    edges: [{ id: 'seal-backups', kind: 'sealed' }],
  },
  {
    title: 'Write the catalogue',
    text: 'Each backup ends with a catalogue that lists every item in the snapshot and its checksum. It contains subjects, file names and folder names, so it is sealed with the same data key as the content.',
    detail:
      'One manifest per snapshot, holding a plain SHA-256 of each item\u2019s content alongside its storage key.',
    nodes: ['seal', 'catalogue'],
    edges: [{ id: 'seal-catalogue', kind: 'sealed' }],
  },
  {
    title: 'Restore and check',
    text: 'To restore, Atlas opens the sealed item and the catalogue with the data key, then compares the item with the checksum the catalogue recorded. Only an item that matches goes back to Microsoft 365. Anything that fails is reported as an error, never restored quietly.',
    detail:
      'SHA-256 compared in constant time. Large files stream into a Graph upload session that commits only after the GCM tag and checksum pass.',
    nodes: ['backups', 'catalogue', 'seal', 'fingerprint', 'reader', 'm365'],
    edges: [
      { id: 'seal-backups', kind: 'sealed', reverse: true },
      { id: 'seal-catalogue', kind: 'sealed', reverse: true },
      { id: 'fingerprint-seal', kind: 'plain', reverse: true },
      { id: 'reader-fingerprint', kind: 'plain', reverse: true },
      { id: 'm365-reader', kind: 'plain', reverse: true },
    ],
  },
];
