import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'M365 Atlas',
  description: 'Secure, deduplicated Microsoft 365 mailbox backups to S3-compatible storage.',

  base: '/',
  cleanUrls: true,

  // Internal planning artefacts under docs/superpowers/ are unreferenced by any page
  // and were being published to the public site.
  srcExclude: ['superpowers/**'],
  appearance: 'dark',

  head: [
    [
      'meta',
      {
        name: 'keywords',
        content: 'm365, backup, email, microsoft 365, s3, minio, encryption, outlook',
      },
    ],
  ],

  themeConfig: {
    siteTitle: 'M365 Atlas',

    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'Reference', link: '/reference/cli' },
      {
        text: 'npm',
        items: [
          { text: '@wisecom/atlas-cli', link: 'https://www.npmjs.com/package/@wisecom/atlas-cli' },
          { text: '@wisecom/atlas-sdk', link: 'https://www.npmjs.com/package/@wisecom/atlas-sdk' },
        ],
      },
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting Started', link: '/getting-started' },
          { text: 'Concepts', link: '/concepts' },
          { text: 'Configuration', link: '/configuration' },
          { text: 'Azure AD Setup', link: '/azure-ad-setup' },
          { text: 'Security', link: '/security' },
          { text: 'Troubleshooting', link: '/troubleshooting' },
        ],
      },
      {
        text: 'Workloads',
        items: [
          { text: 'OneDrive Backup', link: '/onedrive-backup' },
          { text: 'SharePoint Backup', link: '/sharepoint-backup' },
        ],
      },
      {
        text: 'Self-Hosting',
        items: [
          { text: 'Overview', link: '/self-hosting/' },
          { text: 'Storage Setup', link: '/self-hosting/storage' },
          { text: 'Scheduling & Bandwidth', link: '/self-hosting/scheduling' },
          { text: 'Replication Setup', link: '/self-hosting/replication' },
        ],
      },
      {
        text: 'Operations',
        items: [
          { text: 'Immutability & Object Lock', link: '/operations/immutability' },
          { text: 'Delta Sync', link: '/operations/delta-sync' },
          { text: 'Storage Layout', link: '/operations/storage-layout' },
          { text: 'Replication', link: '/operations/replication' },
          { text: 'Graph API Rate Limits', link: '/operations/graph-rate-limits' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'CLI Commands', link: '/reference/cli' },
          { text: 'CLI Recovery & Management', link: '/reference/cli-recovery' },
          { text: 'Programmatic SDK', link: '/reference/sdk' },
          { text: 'Examples', link: '/reference/examples' },
          { text: 'Migrating to v5', link: '/migration/v5' },
        ],
      },
      {
        text: 'Development',
        items: [
          { text: 'Microsoft Graph API Skill', link: '/development/msgraph-skill' },
          { text: 'Graph Request Tracing', link: '/development/graph-tap' },
          { text: 'Performance Profiling', link: '/development/performance-profiling' },
          { text: 'Release Process', link: '/development/releases' },
        ],
      },
      {
        text: 'Project',
        items: [{ text: 'Roadmap', link: '/roadmap' }],
      },
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/wisecom-oy/atlas' }],

    editLink: {
      pattern: 'https://github.com/wisecom-oy/atlas/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the Apache-2.0 License.',
      copyright: 'Copyright 2026 Wisecom Oy',
    },

    search: {
      provider: 'local',
    },
  },
});
