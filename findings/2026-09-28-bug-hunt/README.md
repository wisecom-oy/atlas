# Bug hunt, 2026-09-28: backup, restore and verification flows

Code review of the backup, restore and verification flows across Outlook, OneDrive, SharePoint
and the shared `drive` and `core` packages, at commit `4d6ee39` (v5.2.2). Each finding was
triaged with `.claude/skills/triage-finding` and written up with `.claude/skills/write-issue`.

| #   | Finding                                                                                                                                | Priority | Labels            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------- |
| 01  | [Outlook `restore -s` and `save -s` read one delta manifest](01-outlook-snapshot-restore-save-read-single-manifest.md)                 | high     | `bug`             |
| 02  | [OneDrive mid-drive failure saves tracking for discarded entries](02-onedrive-drive-failure-commits-tracking-for-discarded-entries.md) | high     | `bug`             |
| 03  | [Outlook interrupt drops pending attachments on a complete folder](03-outlook-interrupt-drops-pending-attachments-folder-complete.md)  | medium   | `bug`             |
| 04  | [Drive full re-crawl records no tombstones](04-drive-full-recrawl-has-no-tombstones.md)                                                | medium   | `bug`             |
| 05  | [Drive backup leaks the tenant context on retention failure](05-drive-backup-context-not-destroyed-on-retention-failure.md)            | low      | `bug`, `security` |

Finding 02 was reproduced with a unit test against `scan_all_drives`; the others are verified by
reading the code paths cited in each file.

Checked and dropped: drive restore checksum handling (both providers verify before upload),
Outlook restore checksum binding (#340 holds), drive verification chain and tombstone handling
(#173 holds), OneDrive and SharePoint cursor-after-manifest ordering (#339 holds).
