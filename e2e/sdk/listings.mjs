/**
 * Snapshot ids per workload, from both listing methods, for comparison with the S3 key names.
 *
 * Outlook is always listed. OneDrive and SharePoint are listed when their owner or site is set,
 * contacts and calendar when E2E_LIST_CONTACTS or E2E_LIST_CALENDAR is `1` (the Python side sets
 * those only when the bucket holds that workload). Prints `{ workload: { snapshots, summaries } }`
 * with snapshot ids only.
 */

import { create_instance, main, required_env } from './lib.mjs';

const ids = (rows) => rows.map((row) => row.snapshotId).sort();

/** Both listings of one owner: decrypted manifests and summary-index rows. */
async function list_both(api, owner) {
  return {
    snapshots: ids(await api.listSnapshots(owner)),
    summaries: ids(await api.listSnapshotSummaries(owner)),
  };
}

await main(async () => {
  const mailbox = required_env('E2E_MAILBOX');
  const atlas = create_instance();
  try {
    const listed = { outlook: await list_both(atlas.outlook, mailbox) };
    if (process.env.E2E_ONEDRIVE_OWNER) {
      listed.onedrive = await list_both(atlas.onedrive, process.env.E2E_ONEDRIVE_OWNER);
    }
    if (process.env.E2E_SHAREPOINT_SITE) {
      listed.sharepoint = await list_both(atlas.sharepoint, process.env.E2E_SHAREPOINT_SITE);
    }
    if (process.env.E2E_LIST_CONTACTS === '1') {
      listed.contacts = await list_both(atlas.contacts, mailbox);
    }
    if (process.env.E2E_LIST_CALENDAR === '1') {
      listed.calendar = await list_both(atlas.calendar, mailbox);
    }
    return listed;
  } finally {
    await atlas.dispose();
  }
});
