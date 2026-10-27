---
outline: false
description: Follow one Microsoft 365 email or file through encryption into S3 backup storage and back out again, using an interactive step-by-step diagram.
---

# How your data travels

This page follows one email or file from Microsoft 365 into your backup storage and back again. Step through the diagram, or press **Play tour**. Select any box to jump to the step where it does its work.

<DataJourney />

## The three ideas behind it

**Only you can open the backups.** Everything is sealed with a data key, and that key is locked with your passphrase. The storage provider and anyone who copies the bucket see only sealed data. The flip side is that a lost passphrase cannot be recovered.

**Unchanged content is not uploaded again.** Fingerprints let Atlas recognise content it already holds for the same mailbox, drive, or site, so repeat backups upload only what is new.

**Every restore is checked.** The catalogue records what each item looked like at backup time. An item that does not match is reported, not restored.

## Learn more

| Topic                                            | Page                                                     |
| ------------------------------------------------ | -------------------------------------------------------- |
| Keys, encryption, and what an attacker could see | [Security model](/security)                              |
| Protecting backups from deletion                 | [Immutability and Object Lock](/operations/immutability) |
| What sits where in the bucket                    | [Storage layout](/operations/storage-layout)             |
| How Atlas finds what changed                     | [Delta sync](/operations/delta-sync)                     |
