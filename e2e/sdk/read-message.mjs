/**
 * `readMessage(snapshot, '1')` for every snapshot of the mailbox, plus the two lookups of an
 * unknown snapshot that the docs say resolve to `undefined`.
 *
 * The stored bytes are not printed. Per snapshot this prints whether a message was found, its
 * payload format, whether it is MIME, and its subject only when the subject starts with the run
 * marker, which every seeded message's does.
 */

import { create_instance, main, required_env } from './lib.mjs';

/** The Subject header of a MIME message, if it is one of this run's fixtures. */
function marked_subject(raw, marker) {
  const header = /^Subject:[ \t]*(.*?)\r?$/im.exec(raw);
  const subject = header?.[1] ?? '';
  return subject.startsWith(marker) ? subject : null;
}

await main(async () => {
  const owner = required_env('E2E_OWNER_ID');
  const marker = required_env('E2E_RUN_MARKER');
  const unknown = required_env('E2E_UNKNOWN_SNAPSHOT');
  const atlas = create_instance();
  try {
    const messages = [];
    for (const { snapshotId: snapshot_id } of await atlas.outlook.listSnapshotSummaries(owner)) {
      const message = await atlas.outlook.readMessage(snapshot_id, '1');
      const raw = message?.raw?.toString('utf8') ?? '';
      messages.push({
        snapshot_id,
        found: message !== undefined,
        payload_format: message?.payloadFormat ?? null,
        mime: raw.includes('MIME-Version:'),
        subject: marked_subject(raw, marker),
      });
    }
    return {
      messages,
      unknown_message_is_undefined: (await atlas.outlook.readMessage(unknown, '1')) === undefined,
      unknown_detail_is_undefined: (await atlas.outlook.getSnapshotDetail(unknown)) === undefined,
    };
  } finally {
    await atlas.dispose();
  }
});
