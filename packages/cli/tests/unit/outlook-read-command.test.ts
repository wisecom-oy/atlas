import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { execute_outlook_read } from '@/commands/outlook-catalog.handler';
import { CATALOG_USE_CASE_TOKEN, type CatalogUseCase } from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';

const MIME = Buffer.from(
  [
    'Received: from mx.test.com by mail.test.com; Mon, 02 Mar 2026 10:00:01 +0000',
    'Authentication-Results: spf=pass smtp.mailfrom=test.com; dkim=pass',
    'From: Alice Example <alice@test.com>',
    'To: Bob Example <bob@test.com>',
    'Subject: Quarterly report',
    'Date: Mon, 02 Mar 2026 10:00:00 +0000',
    'Message-ID: <report-1@test.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="B1"',
    '',
    '--B1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Numbers are attached.',
    '--B1',
    'Content-Type: text/csv; name="q1.csv"',
    'Content-Disposition: attachment; filename="q1.csv"',
    'Content-Transfer-Encoding: base64',
    '',
    'cSxhbW91bnQKMSwxMDAK',
    '--B1--',
    '',
  ].join('\r\n'),
);

const JSON_MESSAGE = { subject: 'Legacy', body: { contentType: 'text', content: 'Plain body' } };

describe('execute_outlook_read', () => {
  let container: Container;
  let catalog: CatalogUseCase;
  let stdout_spy: MockInstance<typeof process.stdout.write>;
  let log_spy: MockInstance<typeof console.log>;

  beforeEach(() => {
    catalog = {
      list_mailboxes: vi.fn().mockResolvedValue([]),
      list_snapshots: vi.fn().mockResolvedValue([]),
      get_snapshot_detail: vi.fn().mockResolvedValue(undefined),
      read_message: vi.fn().mockResolvedValue(undefined),
    };

    container = new Container();
    container.bind(CATALOG_USE_CASE_TOKEN).toConstantValue(catalog);
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'test-tenant' });

    // Records writes while still letting Ink flush its frames -- a stubbed
    // write stalls Ink's unmount and the render never resolves.
    stdout_spy = vi.spyOn(process.stdout, 'write');
    log_spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    stdout_spy.mockRestore();
    log_spy.mockRestore();
  });

  function captured_stdout(): string {
    return stdout_spy.mock.calls
      .map(([chunk]) => (Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk)))
      .join('');
  }

  it('writes the MIME blob verbatim for --raw, with no banner or wrapping', async () => {
    vi.mocked(catalog.read_message).mockResolvedValue({
      raw: MIME,
      payload_format: 'mime',
      attachments: [],
    });

    await execute_outlook_read(container, { snapshot: 'snap-1', message: '1', raw: true });

    expect(stdout_spy).toHaveBeenCalledTimes(1);
    expect(stdout_spy.mock.calls[0]?.[0]).toBe(MIME);
    expect(captured_stdout()).toBe(MIME.toString('utf-8'));
    expect(log_spy).not.toHaveBeenCalled();
  });

  it('still prints pretty JSON for --raw on a legacy JSON entry', async () => {
    const raw = Buffer.from(JSON.stringify(JSON_MESSAGE));
    vi.mocked(catalog.read_message).mockResolvedValue({
      raw,
      message: JSON_MESSAGE,
      attachments: [],
    });

    await execute_outlook_read(container, { snapshot: 'snap-1', message: '1', raw: true });

    expect(log_spy).toHaveBeenCalledWith(JSON.stringify(JSON_MESSAGE, null, 2));
  });

  it('prints parsed headers, body, and embedded attachments for a MIME entry', async () => {
    vi.mocked(catalog.read_message).mockResolvedValue({
      raw: MIME,
      payload_format: 'mime',
      attachments: [],
    });

    await execute_outlook_read(container, { snapshot: 'snap-1', message: '1' });

    const printed = captured_stdout();
    expect(printed).toContain('Quarterly report');
    expect(printed).toContain('alice@test.com');
    expect(printed).toContain('bob@test.com');
    expect(printed).toContain('Numbers are attached.');
    expect(printed).toContain('Attachments (1):');
    expect(printed).toContain('q1.csv');
    expect(printed).toContain('text/csv');
  });

  it('reports a missing message with exit code 1', async () => {
    await execute_outlook_read(container, { snapshot: 'snap-1', message: '99' });

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});
