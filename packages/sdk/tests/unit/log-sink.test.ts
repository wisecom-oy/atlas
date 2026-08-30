import { describe, expect, it, vi } from 'vitest';
import type { LogFields, LogSink } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { resolve_log_sink, scope_api_logging } from '@/log-scope';

function recording_sink(): {
  sink: LogSink;
  lines: { level: string; message: string; fields?: LogFields | undefined }[];
} {
  const lines: { level: string; message: string; fields?: LogFields | undefined }[] = [];
  const record =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      lines.push({ level, message, fields });
    };
  return {
    lines,
    sink: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
  };
}

/** Stands in for an SDK namespace: async methods that log from inside a service. */
function fake_api() {
  return {
    async backup(mailbox: string): Promise<string> {
      await Promise.resolve();
      logger.warn(`skipped an attachment for ${mailbox}`);
      return 'done';
    },
    async verify(): Promise<void> {
      logger.info('verified');
    },
    not_a_function: 42,
  };
}

describe('resolve_log_sink', () => {
  it('falls back to silence when the host passes no logger', () => {
    const sink = resolve_log_sink(undefined);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    sink.info('nothing');
    sink.error('also nothing');

    expect(write).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('uses the host sink when given one', () => {
    const { sink } = recording_sink();

    expect(resolve_log_sink(sink)).toBe(sink);
  });
});

describe('scope_api_logging', () => {
  it('routes a method\u2019s log output to the sink', async () => {
    const { sink, lines } = recording_sink();
    const api = scope_api_logging(fake_api(), 'tenant-1', sink);

    await api.backup('user@example.com');

    expect(lines).toEqual([
      {
        level: 'warn',
        message: 'skipped an attachment for user@example.com',
        fields: { tenant_id: 'tenant-1', operation: 'backup' },
      },
    ]);
  });

  it('tags each line with the method that produced it', async () => {
    const { sink, lines } = recording_sink();
    const api = scope_api_logging(fake_api(), 'tenant-1', sink);

    await api.backup('a@example.com');
    await api.verify();

    expect(lines.map((l) => l.fields?.['operation'])).toEqual(['backup', 'verify']);
  });

  it('keeps two instances apart, which a module-global logger cannot', async () => {
    const first = recording_sink();
    const second = recording_sink();
    const api_a = scope_api_logging(fake_api(), 'tenant-a', first.sink);
    const api_b = scope_api_logging(fake_api(), 'tenant-b', second.sink);

    await Promise.all([api_a.verify(), api_b.verify()]);

    expect(first.lines.map((l) => l.fields?.['tenant_id'])).toEqual(['tenant-a']);
    expect(second.lines.map((l) => l.fields?.['tenant_id'])).toEqual(['tenant-b']);
  });

  it('preserves the return value and rejects as the method does', async () => {
    const { sink } = recording_sink();
    const api = scope_api_logging(
      {
        async ok(): Promise<string> {
          return 'value';
        },
        async boom(): Promise<never> {
          throw new Error('from the service');
        },
      },
      'tenant-1',
      sink,
    );

    await expect(api.ok()).resolves.toBe('value');
    await expect(api.boom()).rejects.toThrow('from the service');
  });

  it('passes every argument through untouched', async () => {
    const { sink } = recording_sink();
    const spy = vi.fn(async (..._args: unknown[]) => undefined);
    const api = scope_api_logging({ run: spy }, 'tenant-1', sink);

    await api.run('a', 2, { c: true }, undefined);

    expect(spy).toHaveBeenCalledWith('a', 2, { c: true }, undefined);
  });

  it('leaves non-function properties alone', () => {
    const { sink } = recording_sink();
    const api = scope_api_logging(fake_api(), 'tenant-1', sink);

    // The instance nests sub-API objects next to its own methods.
    expect(api.not_a_function).toBe(42);
  });

  it('writes nothing to the console for an instance with no logger', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = scope_api_logging(fake_api(), 'tenant-1', resolve_log_sink(undefined));

    await api.backup('user@example.com');
    await api.verify();

    // The acceptance criterion of issue #41: with no logger, SDK operations
    // write nothing to stdout.
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
