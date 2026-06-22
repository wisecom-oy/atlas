const DOMAIN_RULES: Array<{ pattern: RegExp; domain: string }> = [
  { pattern: /packages\/s3\//, domain: '@atlas/s3' },
  { pattern: /packages\/m365-graph\//, domain: '@atlas/m365-graph' },
  { pattern: /packages\/core\/src\/adapters\/keystore\//, domain: '@atlas/core/crypto' },
  { pattern: /packages\/core\//, domain: '@atlas/core' },
  { pattern: /packages\/outlook\/src\/services\/backup\//, domain: '@atlas/outlook/backup' },
  { pattern: /packages\/outlook\/src\/services\/restore\//, domain: '@atlas/outlook/restore' },
  { pattern: /packages\/outlook\//, domain: '@atlas/outlook' },
  { pattern: /packages\/onedrive\//, domain: '@atlas/onedrive' },
  { pattern: /packages\/sharepoint\//, domain: '@atlas/sharepoint' },
  { pattern: /packages\/cli\//, domain: '@atlas/cli' },
  { pattern: /packages\/sdk\//, domain: '@atlas/sdk' },
  { pattern: /node:crypto/, domain: 'node:crypto' },
  { pattern: /node:internal\/streams/, domain: 'node:streams' },
  { pattern: /node:internal\//, domain: 'node:internals' },
  { pattern: /node:net|node:tls|node:https|node:http/, domain: 'node:network' },
  { pattern: /node:fs|node:path/, domain: 'node:fs' },
  { pattern: /node:/, domain: 'node:other' },
  { pattern: /@aws-sdk\//, domain: 'aws-sdk' },
  { pattern: /@microsoft\/microsoft-graph-client/, domain: 'ms-graph-sdk' },
  { pattern: /node_modules\//, domain: 'dependencies' },
];

/** Classifies a V8 script URL into an Atlas domain bucket. */
export function classify_domain(url: string): string {
  if (!url || url === '' || url === '(unknown)') return '(runtime)';

  for (const rule of DOMAIN_RULES) {
    if (rule.pattern.test(url)) return rule.domain;
  }

  return '(other)';
}
