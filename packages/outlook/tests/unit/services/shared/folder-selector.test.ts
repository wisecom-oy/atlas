import { describe, it, expect } from 'vitest';
import { folder_matches_selector } from '@/services/shared/folder-selector';

describe('folder_matches_selector', () => {
  it('matches an exact path', () => {
    expect(folder_matches_selector('Inbox/Projects', 'Inbox/Projects')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(folder_matches_selector('Inbox/Projects', 'inbox/projects')).toBe(true);
    expect(folder_matches_selector('Inbox', 'INBOX')).toBe(true);
  });

  it('selects the whole subtree beneath a matched folder', () => {
    expect(folder_matches_selector('Inbox/Projects/2026', 'Inbox')).toBe(true);
    expect(folder_matches_selector('Inbox/Projects/2026', 'Inbox/Projects')).toBe(true);
  });

  it('matches a bare folder name at any depth', () => {
    expect(folder_matches_selector('Inbox/Projects', 'Projects')).toBe(true);
    expect(folder_matches_selector('Inbox/Projects/2026', 'Projects')).toBe(true);
  });

  it('does not match a partial segment', () => {
    expect(folder_matches_selector('Inbox/Projects', 'Proj')).toBe(false);
    expect(folder_matches_selector('Inboxes', 'Inbox')).toBe(false);
  });

  it('does not match a parent when the child was selected', () => {
    expect(folder_matches_selector('Inbox', 'Inbox/Projects')).toBe(false);
  });

  it('ignores surrounding slashes in the selector', () => {
    expect(folder_matches_selector('Inbox/Projects', '/Inbox/Projects/')).toBe(true);
  });

  it('never matches on an empty selector', () => {
    expect(folder_matches_selector('Inbox', '')).toBe(false);
    expect(folder_matches_selector('Inbox', '/')).toBe(false);
  });
});
