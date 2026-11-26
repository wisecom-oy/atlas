import { afterEach, describe, expect, it, vi } from 'vitest';
import { get_active_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { resolve_under_gate } from '@/adapters/gated-resolution';
import type { InterruptGate } from '@/adapters/interrupt-gate';

/** A gate whose first Ctrl+C is `interrupt()`, without a real SIGINT listener. */
function make_gate(): InterruptGate & { interrupt: (reason: Error) => void } {
  const controller = new AbortController();
  return {
    should_interrupt: () => controller.signal.aborted,
    abort_signal: controller.signal,
    dispose: () => undefined,
    interrupt: (reason) => controller.abort(reason),
  };
}

const STOP = new Error('Run interrupted by Ctrl+C');

describe('resolve_under_gate (issue #876)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns what the lookup resolved when no Ctrl+C came', async () => {
    await expect(resolve_under_gate(make_gate(), async () => 'owner-id')).resolves.toBe('owner-id');
  });

  it("publishes the gate's signal to the Graph calls inside the lookup", async () => {
    const gate = make_gate();
    let seen: AbortSignal | undefined;

    await resolve_under_gate(gate, async () => {
      seen = get_active_abort_signal();
    });

    expect(seen).toBe(gate.abort_signal);
  });

  it('rejects at once on Ctrl+C, even while the lookup ignores the signal', async () => {
    const gate = make_gate();
    const pending = resolve_under_gate(gate, () => new Promise<never>(() => undefined));

    gate.interrupt(STOP);

    await expect(pending).rejects.toBe(STOP);
  });

  it('stops after a lookup that finished just as Ctrl+C landed', async () => {
    const gate = make_gate();

    const pending = resolve_under_gate(gate, async () => {
      gate.interrupt(STOP);
      return 'owner-id';
    });

    await expect(pending).rejects.toBe(STOP);
  });

  it('never starts the lookup once Ctrl+C has fired', async () => {
    const gate = make_gate();
    gate.interrupt(STOP);
    const lookup = vi.fn(async () => 'owner-id');

    await expect(resolve_under_gate(gate, lookup)).rejects.toBe(STOP);
    expect(lookup).not.toHaveBeenCalled();
  });
});
