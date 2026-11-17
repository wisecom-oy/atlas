---
layout: home
title: Atlas
description: Atlas is an open-source Microsoft 365 backup engine that encrypts and deduplicates mail, contacts, calendars, OneDrive, SharePoint, and Teams backups to S3-compatible storage.
titleTemplate: Microsoft 365 backup engine by Wisecom
hero:
  name: Atlas
  text: Microsoft 365 backup<br>you can read.
  tagline: The open-source engine behind Wisecom Continuity. Encrypted, deduplicated backups of Exchange Online, OneDrive, SharePoint and Teams to S3‑compatible storage, as a CLI or a Node.js SDK.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: CLI reference
      link: /reference/cli
    - theme: alt
      text: SDK reference
      link: /reference/sdk

features:
  - title: Encrypted per tenant
    details: Each tenant has its own AES‑256‑GCM data key, locked by a key derived from your passphrase. Storage never sees plaintext.
    link: /security
  - title: Stored once
    details: Each unique message, attachment, and file is stored once, named by a keyed hash of its content. Object names reveal nothing without your key.
    link: /concepts
  - title: Immutable by storage
    details: With <code>--retention-days</code> on an Object Lock bucket, the bucket itself enforces retention. Atlas metadata an attacker could edit plays no part.
    link: /operations/immutability
  - title: Incremental by default
    details: After the first run, Atlas fetches only what changed in Microsoft 365. An interrupted run resumes from its last sync checkpoint, and a full read happens only in specific cases, such as a rejected checkpoint.
    link: /operations/delta-sync
  - title: Six workloads
    details: Outlook mail, contacts, and calendars, OneDrive files, SharePoint document libraries, and Teams channel messages, under one encryption and storage model.
    link: /onedrive-backup
  - title: CLI and SDK
    details: 'The CLI fits scripts and cron jobs. The SDK embeds the same engine in Node.js with a typed API.'
    link: /reference/sdk
---

<WcBits />

<section class="wc-upsell" aria-labelledby="wc-upsell-title">
  <div class="wc-card">
    <div>
      <div class="wc-head">
        <img class="wc-mark" src="/wisecom-mark-light.png" alt="" />
        <span class="wc-eyebrow">Wisecom Continuity</span>
      </div>
      <h2 id="wc-upsell-title">Rather not run it yourself?</h2>
      <p>Wisecom Continuity is Atlas as a managed service. Connect your tenant with a scoped Entra ID app and backups run three times a day, are verified every week, and land in immutable storage in the EU region you choose.</p>
      <div class="wc-actions">
        <a class="wc-btn primary" href="https://wisecom.fi/en/products/continuity">See Wisecom Continuity →</a>
        <a class="wc-btn" href="https://wisecom.fi/en/pricing">Pricing from 99 €/TB</a>
      </div>
    </div>
    <div>
      <ul class="wc-grid">
        <li><strong>Verified weekly</strong><span>Integrity report, alert on failure.</span></li>
        <li><strong>Immutable storage</strong><span>Written once, EU by default.</span></li>
        <li><strong>Separate control plane</strong><span>Tenant admins cannot delete.</span></li>
        <li><strong>Audit log to your SIEM</strong><span>Splunk, Sentinel, Elastic, Wazuh. Cybersecure tier.</span></li>
      </ul>
      <p class="wc-setup">Get all this up and running in less than 10 clicks.</p>
    </div>
  </div>
  <p class="wc-note">Same engine, same encryption. Self-host Atlas for free under Apache-2.0, or let Wisecom operate it.</p>
</section>
