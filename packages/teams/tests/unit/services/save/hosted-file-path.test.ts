import { describe, expect, it } from 'vitest';
import { hosted_archive_path, inline_image_type } from '@/services/save/hosted-file-path';

describe('hosted_archive_path', () => {
  it('names a root message hosted file by its message and content id, with an extension for its type', () => {
    expect(hosted_archive_path('channels/Team-c1', { root_id: 'r1' }, 'h1', 'image/png')).toBe(
      'channels/Team-c1/hosted/r1/h1.png',
    );
  });

  it('files a reply hosted file under the reply id, not its root', () => {
    expect(
      hosted_archive_path(
        'channels/Team-c1',
        { root_id: 'r1', reply_id: 'p9' },
        'h1',
        'image/jpeg',
      ),
    ).toBe('channels/Team-c1/hosted/p9/h1.jpg');
  });

  it('ignores content-type parameters and letter case when choosing the extension', () => {
    expect(hosted_archive_path('d', { root_id: 'r' }, 'h', 'Text/Plain; charset=utf-8')).toBe(
      'd/hosted/r/h.txt',
    );
  });

  it('saves HTML as text and any other type as .bin, so no file runs in a browser', () => {
    expect(hosted_archive_path('d', { root_id: 'r' }, 'h', 'text/html')).toBe('d/hosted/r/h.txt');
    expect(hosted_archive_path('d', { root_id: 'r' }, 'h', 'image/svg+xml')).toBe(
      'd/hosted/r/h.bin',
    );
    expect(hosted_archive_path('d', { root_id: 'r' }, 'h', 'application/pdf')).toBe(
      'd/hosted/r/h.bin',
    );
    expect(hosted_archive_path('d', { root_id: 'r' }, 'h', undefined)).toBe('d/hosted/r/h.bin');
  });

  it('keeps path separators and dot segments out of the owner and content names', () => {
    const path = hosted_archive_path('d', { root_id: '../r' }, '../../h', 'image/png');

    expect(path).toBe('d/hosted/---r/------h.png');
    expect(path.split('/')).toHaveLength(4);
  });
});

describe('inline_image_type', () => {
  it('returns the normalized type for image types and undefined for anything else', () => {
    expect(inline_image_type('Image/PNG; name=x')).toBe('image/png');
    expect(inline_image_type('application/pdf')).toBeUndefined();
    expect(inline_image_type(undefined)).toBeUndefined();
  });
});
