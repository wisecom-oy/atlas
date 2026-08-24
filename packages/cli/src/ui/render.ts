import { render } from 'ink';
import type { Instance, RenderOptions } from 'ink';
import type { ReactElement } from 'react';

/**
 * Ink and the `DataTable` width budget both read `process.stdout.columns`, which Node populates
 * only for a TTY. Piped or redirected output therefore falls back to 80 columns and truncates long
 * cells such as site URLs. Honouring `COLUMNS` is the POSIX convention and lets
 * `atlas ... > out.txt` keep rows intact.
 *
 * This runs at module load, so it must never throw: on some stdout implementations `columns` is a
 * read-only accessor, and an exception here would take down every command before it starts.
 */
function apply_columns_override(): void {
  if (process.stdout.isTTY) return;
  const columns = Number(process.env['COLUMNS']);
  if (!Number.isInteger(columns) || columns <= 0) return;
  try {
    Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
  } catch {
    // A stdout that refuses the override keeps its own width; layout is cosmetic, crashing is not.
  }
}

apply_columns_override();

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
