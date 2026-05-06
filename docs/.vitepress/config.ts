import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'M365 Atlas',
  description: 'Secure, deduplicated Microsoft 365 mailbox backups to S3-compatible storage.',

  base: '/atlas/',
  cleanUrls: true,
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
        link: 'https://www.npmjs.com/package/m365-atlas',
      },
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting Started', link: '/getting-started' },
          { text: 'Self-Hosting', link: '/self-hosting' },
          { text: 'Configuration', link: '/configuration' },
          { text: 'Azure AD Setup', link: '/azure-ad-setup' },
          { text: 'OneDrive Backup', link: '/onedrive-backup' },
          { text: 'Security', link: '/security' },
        ],
      },
      {
        text: 'Operations',
        items: [
          { text: 'Immutability & Object Lock', link: '/operations/immutability' },
          { text: 'Delta Sync', link: '/operations/delta-sync' },
          { text: 'Storage Layout', link: '/operations/storage-layout' },
          { text: 'Replication', link: '/operations/replication' },
          { text: 'Performance Profiling', link: '/operations/performance-profiling' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'CLI Commands', link: '/reference/cli' },
          { text: 'Programmatic SDK', link: '/reference/sdk' },
          { text: 'SDK Examples', link: '/reference/examples' },
        ],
      },
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/miikaok/atlas' }],

    editLink: {
      pattern: 'https://github.com/miikaok/atlas/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the Apache-2.0 License.',
      copyright: 'Copyright 2026 Miika Oja-Kaukola',
    },

    search: {
      provider: 'local',
    },
  },
});
