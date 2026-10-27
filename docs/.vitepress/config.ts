import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Atlas',
  titleTemplate: ':title · Atlas by Wisecom',
  description:
    'Atlas by Wisecom: open-source, encrypted Microsoft 365 backup to S3-compatible storage. CLI and Node.js SDK.',

  base: '/',
  cleanUrls: true,

  // Internal planning artefacts under docs/superpowers/ are unreferenced by any page
  // and were being published to the public site.
  srcExclude: ['superpowers/**'],
  appearance: 'dark',
  lastUpdated: true,

  head: [
    ['meta', { name: 'theme-color', content: '#0a0a0a' }],
    [
      'link',
      {
        rel: 'icon',
        type: 'image/png',
        href: '/favicon-dark.png',
        media: '(prefers-color-scheme: light)',
      },
    ],
    [
      'link',
      {
        rel: 'icon',
        type: 'image/png',
        href: '/favicon-light.png',
        media: '(prefers-color-scheme: dark)',
      },
    ],
    [
      'meta',
      {
        name: 'keywords',
        content:
          'atlas, wisecom, microsoft 365 backup, exchange online, onedrive, sharepoint, s3, object lock, encryption',
      },
    ],
  ],

  themeConfig: {
    logo: {
      light: '/wisecom-wordmark-dark.png',
      dark: '/wisecom-wordmark-light.png',
      alt: 'Wisecom',
    },
    siteTitle: 'Atlas',

    nav: [
      {
        text: 'Guide',
        link: '/getting-started',
        activeMatch:
          '^/(getting-started|concepts|configuration|azure-ad-setup|security|troubleshooting|onedrive|sharepoint|self-hosting|operations)',
      },
      { text: 'Reference', link: '/reference/cli', activeMatch: '^/(reference|migration)/' },
      {
        text: 'More',
        items: [
          { text: 'Roadmap', link: '/roadmap' },
          { text: 'Development', link: '/development/releases' },
          {
            text: '@wisecom/atlas-cli on npm',
            link: 'https://www.npmjs.com/package/@wisecom/atlas-cli',
          },
          {
            text: '@wisecom/atlas-sdk on npm',
            link: 'https://www.npmjs.com/package/@wisecom/atlas-sdk',
          },
        ],
      },
      { text: 'Wisecom Continuity', link: 'https://wisecom.fi/en/products/continuity' },
    ],

    sidebar: [
      {
        text: 'Get started',
        items: [
          { text: 'Quickstart', link: '/getting-started' },
          { text: 'Concepts', link: '/concepts' },
          { text: 'Entra ID app registration', link: '/azure-ad-setup' },
          { text: 'Configuration', link: '/configuration' },
        ],
      },
      {
        text: 'Workloads',
        items: [
          { text: 'OneDrive', link: '/onedrive-backup' },
          { text: 'SharePoint', link: '/sharepoint-backup' },
        ],
      },
      {
        text: 'Security',
        items: [
          { text: 'Security model', link: '/security' },
          { text: 'Immutability and Object Lock', link: '/operations/immutability' },
        ],
      },
      {
        text: 'Self-hosting',
        items: [
          { text: 'Overview', link: '/self-hosting/' },
          { text: 'Storage', link: '/self-hosting/storage' },
          { text: 'Scheduling and bandwidth', link: '/self-hosting/scheduling' },
          { text: 'Replication setup', link: '/self-hosting/replication' },
        ],
      },
      {
        text: 'Operations',
        items: [
          { text: 'Delta sync', link: '/operations/delta-sync' },
          { text: 'Storage layout', link: '/operations/storage-layout' },
          { text: 'Storage usage', link: '/operations/storage-usage' },
          { text: 'Replication', link: '/operations/replication' },
          { text: 'Graph rate limits', link: '/operations/graph-rate-limits' },
          { text: 'Troubleshooting', link: '/troubleshooting' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'CLI', link: '/reference/cli' },
          { text: 'CLI recovery and management', link: '/reference/cli-recovery' },
          { text: 'SDK', link: '/reference/sdk' },
          { text: 'Storage request events', link: '/reference/storage-request-events' },
          { text: 'Examples', link: '/reference/examples' },
        ],
      },
      {
        text: 'Migration',
        items: [{ text: 'Upgrading to v6', link: '/migration/v6' }],
      },
      {
        text: 'Development',
        collapsed: true,
        items: [
          { text: 'Release process', link: '/development/releases' },
          { text: 'Test coverage', link: '/development/test-coverage' },
          { text: 'Performance profiling', link: '/development/performance-profiling' },
          { text: 'Graph request tracing', link: '/development/graph-tap' },
          { text: 'Microsoft Graph skill', link: '/development/msgraph-skill' },
        ],
      },
      {
        text: 'Project',
        items: [
          { text: 'Roadmap', link: '/roadmap' },
          { text: 'Wisecom Continuity', link: 'https://wisecom.fi/en/products/continuity' },
        ],
      },
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/wisecom-oy/atlas' }],

    editLink: {
      pattern: 'https://github.com/wisecom-oy/atlas/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message:
        'Atlas is released under the Apache-2.0 License. Managed hosting: <a href="https://wisecom.fi/en/products/continuity">Wisecom Continuity</a>.',
      copyright: '© 2026 Wisecom Oy',
    },

    outline: { level: [2, 3] },

    search: {
      provider: 'local',
    },
  },
});
