import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogFields, LogSink } from '@wisecom/atlas-types';
import { logger } from '@/utils/logger';
import { run_with_log_scope, active_log_scope, SILENT_LOG_SINK } from '@/utils/log-context';

interface Recorded {
  level: string;
  message: string;
  fields?: LogFields | undefined;
}

function recording_sink(): { sink: LogSink; lines: Recorded[] } {
  const lines: Recorded[] = [];
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

describe('logger without a scope', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes to the console, which is what the CLI relies on', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.info('an info line');
    logger.success('a success line');
    logger.warn('a warning');
    logger.error('a failure');

    expect(log).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(active_log_scope()).toBeUndefined();
  });

  it('still gates debug on the DEBUG env var', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const previous = process.env['DEBUG'];
    delete process.env['DEBUG'];

    logger.debug('quiet');
    expect(debug).not.toHaveBeenCalled();

    process.env['DEBUG'] = '1';
    logger.debug('loud');
    expect(debug).toHaveBeenCalledTimes(1);

    if (previous === undefined) delete process.env['DEBUG'];
    else process.env['DEBUG'] = previous;
  });
});

describe('logger inside a scope', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes every level to the sink and nothing to the console', () => {
    const { sink, lines } = recording_sink();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    run_with_log_scope({ sink }, () => {
      logger.debug('d');
      logger.info('i');
      logger.success('s');
      logger.warn('w');
      logger.error('e');
      logger.banner('b');
    });

    expect(lines.map((l) => `${l.level}:${l.message}`)).toEqual([
      'debug:d',
      'info:i',
      'info:s',
      'warn:w',
      'error:e',
      'info:b',
    ]);
    for (const spy of [log, warn, error, debug]) expect(spy).not.toHaveBeenCalled();
  });

  it('does not gate debug on DEBUG once a sink is installed', () => {
    const { sink, lines } = recording_sink();
    const previous = process.env['DEBUG'];
    delete process.env['DEBUG'];

    run_with_log_scope({ sink }, () => logger.debug('routed anyway'));

    // The sink decides its own level; swallowing debug here would hide lines a
    // host explicitly asked for.
    expect(lines).toHaveLength(1);
    if (previous !== undefined) process.env['DEBUG'] = previous;
  });

  it('attaches the scope fields to every line', () => {
    const { sink, lines } = recording_sink();

    run_with_log_scope({ sink, fields: { tenant_id: 'tenant-1', operation: 'backup' } }, () => {
      logger.warn('skipped an attachment');
    });

    expect(lines[0]?.fields).toEqual({ tenant_id: 'tenant-1', operation: 'backup' });
  });

  it('writes no cursor control, so progress cannot corrupt a host log', () => {
    const { sink, lines } = recording_sink();
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    run_with_log_scope({ sink }, () => {
      logger.progress('50%');
      logger.progress_done();
    });

    expect(write).not.toHaveBeenCalled();
    expect(lines).toHaveLength(0);
  });

  it('survives awaits, so a log line deep inside a service still routes', async () => {
    const { sink, lines } = recording_sink();

    await run_with_log_scope({ sink, fields: { tenant_id: 't' } }, async () => {
      await Promise.resolve();
      await queue_microtasks(4);
      await nested_service_call();
    });

    // This is the whole reason the scope rides on AsyncLocalStorage: the 700-odd
    // existing call sites are reached without being touched.
    expect(lines.map((l) => l.message)).toEqual(['from deep inside']);
    expect(lines[0]?.fields).toEqual({ tenant_id: 't' });
  });

  it('leaves no scope behind once the call returns', () => {
    const { sink } = recording_sink();

    run_with_log_scope({ sink }, () => expect(active_log_scope()).toBeDefined());

    expect(active_log_scope()).toBeUndefined();
  });

  it('keeps concurrent scopes separate', async () => {
    const first = recording_sink();
    const second = recording_sink();

    // A deferred rather than a sleep, so the interleaving is exact: 'a' is
    // suspended mid-scope while 'b' runs to completion in its own scope.
    let release_first: () => void = () => {};
    const first_gate = new Promise<void>((resolve) => {
      release_first = resolve;
    });

    const a = run_with_log_scope({ sink: first.sink, fields: { tenant_id: 'a' } }, async () => {
      await first_gate;
      logger.info('for a');
    });
    const b = run_with_log_scope({ sink: second.sink, fields: { tenant_id: 'b' } }, async () => {
      logger.info('for b');
    });
    await b;
    release_first();
    await a;

    expect(first.lines.map((l) => l.message)).toEqual(['for a']);
    expect(second.lines.map((l) => l.message)).toEqual(['for b']);
  });

  it('writes nothing at all through the silent sink', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    run_with_log_scope({ sink: SILENT_LOG_SINK }, () => {
      logger.info('dropped');
      logger.warn('also dropped');
    });

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

/** Stands in for a service function that logs from several awaits down. */
async function nested_service_call(): Promise<void> {
  await Promise.resolve();
  logger.info('from deep inside');
}

/** Advances past several microtask turns without touching the clock. */
async function queue_microtasks(turns: number): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}
