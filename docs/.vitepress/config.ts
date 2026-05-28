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
          {
            text: 'Self-Hosting',
            collapsed: false,
            items: [
              { text: 'Overview', link: '/self-hosting/' },
              { text: 'Storage Setup', link: '/self-hosting/storage' },
              { text: 'Scheduling & Bandwidth', link: '/self-hosting/scheduling' },
              { text: 'Replication Setup', link: '/self-hosting/replication' },
            ],
          },
          { text: 'Configuration', link: '/configuration' },
          { text: 'Azure AD Setup', link: '/azure-ad-setup' },
          { text: 'Security', link: '/security' },
          { text: 'Concepts', link: '/concepts' },
          { text: 'Troubleshooting', link: '/troubleshooting' },
        ],
      },
      {
        text: 'Operations',
        items: [
          { text: 'Immutability & Object Lock', link: '/operations/immutability' },
          { text: 'Delta Sync', link: '/operations/delta-sync' },
          { text: 'Storage Layout', link: '/operations/storage-layout' },
          { text: 'Replication', link: '/operations/replication' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'CLI Commands', link: '/reference/cli' },
          { text: 'CLI — Recovery & Management', link: '/reference/cli-recovery' },
          { text: 'Programmatic SDK', link: '/reference/sdk' },
          {
            text: 'Examples',
            collapsed: false,
            items: [
              { text: 'Backup Patterns', link: '/reference/examples/backup' },
              { text: 'Maintenance & Monitoring', link: '/reference/examples/maintenance' },
              { text: 'Export & Compliance', link: '/reference/examples/export' },
            ],
          },
        ],
      },
      {
        text: 'Project',
        items: [{ text: 'Roadmap', link: '/roadmap' }],
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
