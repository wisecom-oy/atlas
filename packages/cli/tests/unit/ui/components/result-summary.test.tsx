import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ResultSummary } from '@/ui/components/result-summary';

describe('ResultSummary', () => {
  it('joins entries with separators and appends the suffix', () => {
    const { lastFrame } = render(
      <ResultSummary
        entries={[
          { label: 'stored', value: 5, color: 'green' },
          { label: 'dedup', value: 2, color: 'yellow' },
          { label: 'errors', value: 0, color: 'red' },
        ]}
        suffix="12s"
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('5 stored');
    expect(frame).toContain('2 dedup');
    expect(frame).toContain('0 errors');
    expect(frame).toContain('|');
    expect(frame).toContain('12s');
  });
});
