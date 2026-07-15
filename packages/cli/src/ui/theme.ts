/**
 * Shared visual vocabulary for the Ink-based CLI: level colors, level glyphs,
 * and spinner frames. Mirrors the legacy logger prefixes ([*] [+] [!] [x])
 * so non-TTY output stays grep-compatible with pre-Ink releases.
 */

export type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'debug';

export const LEVEL_COLORS: Record<LogLevel, string> = {
  info: 'blue',
  success: 'green',
  warn: 'yellow',
  error: 'red',
  debug: 'gray',
};

export const LEVEL_GLYPHS: Record<LogLevel, string> = {
  info: '[*]',
  success: '[+]',
  warn: '[!]',
  error: '[x]',
  debug: '[.]',
};

export const ACCENT_COLOR = 'cyan';
export const MUTED_COLOR = 'gray';

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Status glyph + color used by dashboards and result views. */
export const STATUS_STYLES = {
  pending: { glyph: '·', color: MUTED_COLOR },
  active: { glyph: '▶', color: ACCENT_COLOR },
  done: { glyph: '✓', color: 'green' },
  error: { glyph: '✗', color: 'red' },
  warn: { glyph: '!', color: 'yellow' },
} as const;

export type StatusStyle = keyof typeof STATUS_STYLES;
