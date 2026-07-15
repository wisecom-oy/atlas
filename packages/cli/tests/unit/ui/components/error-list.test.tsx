import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ErrorList } from '@/ui/components/error-list';

describe('ErrorList', () => {
  it('lists every error when under the cap', () => {
    const { lastFrame } = render(<ErrorList errors={['boom', 'crash']} />);
    expect(lastFrame()).toContain('- boom');
    expect(lastFrame()).toContain('- crash');
  });

  it('collapses errors beyond the cap into a count', () => {
    const errors = Array.from({ length: 13 }, (_, i) => `error ${i}`);
    const { lastFrame } = render(<ErrorList errors={errors} max={10} />);
    expect(lastFrame()).toContain('error 9');
    expect(lastFrame()).not.toContain('error 10');
    expect(lastFrame()).toContain('… and 3 more');
  });
});
