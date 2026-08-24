import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

/**
 * Exercises the module-load side effect in `@/ui/render`: the override runs once on import, so each
 * case needs the registry reset and the module imported again. A static import would apply it once
 * for the whole file and test nothing (issue #175).
 */
async function load_render_module(): Promise<void> {
  vi.resetModules();
  await import('@/ui/render');
}

describe('render column override', () => {
  const original_columns = process.stdout.columns;
  const original_is_tty = process.stdout.isTTY;
  const original_env = process.env['COLUMNS'];

  function set_stdout(columns: number | undefined, is_tty: boolean): void {
    Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: is_tty, configurable: true });
  }

  beforeEach(() => {
    delete process.env['COLUMNS'];
  });

  afterEach(() => {
    set_stdout(original_columns, original_is_tty);
    if (original_env === undefined) delete process.env['COLUMNS'];
    else process.env['COLUMNS'] = original_env;
  });

  it('adopts COLUMNS when stdout is piped', async () => {
    set_stdout(undefined, false);
    process.env['COLUMNS'] = '4096';

    await load_render_module();

    expect(process.stdout.columns).toBe(4096);
  });

  it('leaves a real terminal alone', async () => {
    set_stdout(120, true);
    process.env['COLUMNS'] = '4096';

    await load_render_module();

    expect(process.stdout.columns).toBe(120);
  });

  it('ignores a COLUMNS value that is not a positive integer', async () => {
    set_stdout(undefined, false);
    process.env['COLUMNS'] = 'wide';

    await load_render_module();

    expect(process.stdout.columns).toBeUndefined();
  });

  it('ignores a zero or negative COLUMNS', async () => {
    set_stdout(undefined, false);
    process.env['COLUMNS'] = '0';

    await load_render_module();

    expect(process.stdout.columns).toBeUndefined();
  });
});
