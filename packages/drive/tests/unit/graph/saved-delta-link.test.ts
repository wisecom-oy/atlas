import { describe, expect, it } from 'vitest';
import { classify_saved_delta_link, plan_delta_start } from '@/graph/saved-delta-link';

const BASE = 'https://graph.microsoft.com/v1.0/drives/d/root/delta';

describe('saved delta link freshness (#580)', () => {
  it('resumes a link that carries both package and shared', () => {
    const link = `${BASE}?$select=id,package,shared&token=t`;
    expect(classify_saved_delta_link(link)).toBe('current');
    expect(plan_delta_start(link)).toEqual({
      resume_link: link,
      reset_detected: false,
      full_enumeration: false,
    });
  });

  it('enumerates afresh but keeps tracking for a link that predates sharing capture', () => {
    const link = `${BASE}?$select=id,package&token=t`;
    expect(classify_saved_delta_link(link)).toBe('predates_sharing');
    expect(plan_delta_start(link)).toEqual({
      resume_link: undefined,
      reset_detected: false,
      full_enumeration: true,
    });
  });

  it('still resets for a link that predates the package facet', () => {
    expect(plan_delta_start(`${BASE}?token=old`)).toEqual({
      resume_link: undefined,
      reset_detected: true,
      full_enumeration: false,
    });
  });

  it('starts a plain enumeration when there is no saved link', () => {
    expect(plan_delta_start(undefined)).toEqual({
      resume_link: undefined,
      reset_detected: false,
      full_enumeration: false,
    });
  });
});
