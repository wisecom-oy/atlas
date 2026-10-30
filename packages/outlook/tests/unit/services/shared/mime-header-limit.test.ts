import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnreadableContentError } from '@wisecom/atlas-types';

const simple_parser = vi.hoisted(() => vi.fn());
vi.mock('mailparser', () => ({ simpleParser: simple_parser }));

const { parse_mime_message } = await import('@/services/shared/mime-message-parser');

/** Builds an error shaped like mailsplit's size limit rejections. */
function max_len_error(message: string): Error {
  return Object.assign(new Error(message), { code: 'EMAXLEN' });
}

// The real mailparser covers the current rejection in mime-message-parser.test.ts. These pin
// the shapes it no longer produces, so a mailparser downgrade or an unrelated limit is handled
// deliberately rather than by accident (issues #411 and #566).
describe('parse_mime_message header block limit', () => {
  beforeEach(() => {
    simple_parser.mockReset();
  });

  it('classifies the header size rejection as unreadable content', async () => {
    simple_parser.mockRejectedValue(max_len_error('Max header size for a MIME node exceeded'));

    const err = await parse_mime_message(Buffer.from('x')).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnreadableContentError);
    expect((err as Error).message).toContain('1 MiB');
  });

  it('classifies a parse that resolved without header lines as unreadable content', async () => {
    simple_parser.mockResolvedValue({ attachments: [] });

    const err = await parse_mime_message(Buffer.from('x')).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnreadableContentError);
  });

  it('passes any other parser limit through unchanged', async () => {
    const child_limit = max_len_error('Max allowed child nodes exceeded');
    simple_parser.mockRejectedValue(child_limit);

    await expect(parse_mime_message(Buffer.from('x'))).rejects.toBe(child_limit);
  });
});
