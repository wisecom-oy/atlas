import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { KeyValueList } from '@/ui/components/key-value-list';

describe('KeyValueList', () => {
  it('aligns values across rows of different label lengths', () => {
    const { lastFrame } = render(
      <KeyValueList
        items={[
          { label: 'Tenant', value: 'contoso' },
          { label: 'Mailbox', value: 'alice@contoso.com' },
        ]}
      />,
    );
    const lines = lastFrame()!.split('\n');
    expect(lines[0]).toContain('Tenant:');
    expect(lines[1]).toContain('Mailbox:');
    expect(lines[0]!.indexOf('contoso')).toBe(lines[1]!.indexOf('alice@contoso.com'));
  });
});
