import { describe, expect, it } from 'vitest';
import { calendar_event } from '@wisecom/atlas-types/testing/stub-calendar-ports';

import {
  body_inline_references,
  needs_attachment_listing,
  unresolved_inline_references,
} from '@/services/backup/calendar-inline-references';

describe('body_inline_references', () => {
  it('returns each cid: content ID of an HTML body once', () => {
    const payload = calendar_event('e1', {
      body: {
        contentType: 'html',
        content: '<img src="cid:a@x"><img src="cid:b"><img src="cid:a@x">',
      },
    });

    expect(body_inline_references(payload)).toEqual(['a@x', 'b']);
  });

  it('treats a body without a contentType as HTML', () => {
    const payload = calendar_event('e1', { body: { content: '<img src="cid:img1">' } });

    expect(body_inline_references(payload)).toEqual(['img1']);
  });

  it('does not scan a plain-text body', () => {
    const payload = calendar_event('e1', { body: { contentType: 'text', content: 'cid:img1' } });

    expect(body_inline_references(payload)).toEqual([]);
  });

  it('returns nothing when the body is missing or has no string content', () => {
    expect(body_inline_references(calendar_event('e1'))).toEqual([]);
    expect(body_inline_references(calendar_event('e2', { body: { content: 7 } }))).toEqual([]);
  });
});

describe('needs_attachment_listing', () => {
  it('lists when Graph reports attachments or the body references one', () => {
    const payload = calendar_event('e1', { hasAttachments: true });
    expect(needs_attachment_listing(payload, [])).toBe(true);
    expect(needs_attachment_listing(calendar_event('e2'), ['img1'])).toBe(true);
  });

  it('does not list when neither signal is present', () => {
    expect(needs_attachment_listing(calendar_event('e1', { hasAttachments: false }), [])).toBe(
      false,
    );
  });
});

describe('unresolved_inline_references', () => {
  it('returns the references no listed attachment carries', () => {
    const listed = [
      {
        id: 'a1',
        name: 'logo.png',
        kind: 'file' as const,
        is_inline: true,
        content_id: 'img1',
        size: 3,
      },
    ];

    expect(unresolved_inline_references(['img1', 'img2'], listed)).toEqual(['img2']);
    expect(unresolved_inline_references(['img1'], [])).toEqual(['img1']);
  });
});
