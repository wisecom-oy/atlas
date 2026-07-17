import { render } from 'ink';
import type { Instance, RenderOptions } from 'ink';
import type { ReactElement } from 'react';

/**
 * Renders a one-shot view (banner, table, summary) and resolves once the
 * final frame is flushed. Safe in non-TTY environments: Ink writes plain
 * lines without ANSI redraw sequences.
 */
export async function render_static_view(element: ReactElement): Promise<void> {
  const instance = render(element, { patchConsole: false, exitOnCtrlC: false });
  instance.unmount();
  await instance.waitUntilExit();
}

/**
 * Mounts a live-updating view (progress dashboards, prompts). The caller owns
 * the lifecycle and must call `unmount()`. `patchConsole` stays enabled so
 * service log lines print above the live region instead of clobbering it.
 */
export function mount_live_view(element: ReactElement, options: RenderOptions = {}): Instance {
  return render(element, { exitOnCtrlC: false, ...options });
}
