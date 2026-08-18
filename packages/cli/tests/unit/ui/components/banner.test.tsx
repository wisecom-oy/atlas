import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { Banner } from '@/ui/components/banner';

describe('Banner', () => {
  it('renders the title inside a border', () => {
    const { lastFrame } = render(<Banner title="Atlas Backup" />);
    const frame = lastFrame()!;
    expect(frame).toContain('Atlas Backup');
    expect(frame).toContain('╭');
    expect(frame).toContain('╰');
  });

  it('renders the subtitle when provided', () => {
    const { lastFrame } = render(<Banner title="Atlas" subtitle="tenant contoso" />);
    expect(lastFrame()).toContain('tenant contoso');
  });
});
