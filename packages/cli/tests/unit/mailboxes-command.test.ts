import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { Container } from 'inversify';
import 'reflect-metadata';
import { register_outlook_command } from '@/commands/outlook.command';
import { format_in_place_archive } from '@/commands/outlook-mgmt.handler';
import { MAILBOX_DISCOVERY_TOKEN } from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import type { MailboxDiscoveryService, MailboxPurpose, TenantMailbox } from '@wisecom/atlas-types';

function make_mailbox(mail: string, licensed = true, purpose?: MailboxPurpose): TenantMailbox {
  return {
    user_id: `uid-${mail}`,
    mail,
    display_name: mail.split('@')[0]!,
    has_exchange_license: licensed,
    ...(licensed ? { exchange_plan_status: 'Enabled' } : {}),
    ...(purpose ? { mailbox_purpose: purpose } : {}),
  };
}

describe('register_outlook_command mailboxes subcommand', () => {
  let container: Container;
  let mock_discovery: MailboxDiscoveryService;
  let program: Command;

  beforeEach(() => {
    container = new Container();
    mock_discovery = {
      list_tenant_mailboxes: vi
        .fn()
        .mockResolvedValue([make_mailbox('alice@t.com'), make_mailbox('bob@t.com', false)]),
    };
    container.bind(MAILBOX_DISCOVERY_TOKEN).toConstantValue(mock_discovery);
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'test-tenant' });

    program = new Command();
    register_outlook_command(program, () => container);
  });

  it('registers the outlook mailboxes subcommand', () => {
    const outlook = program.commands.find((c) => c.name() === 'outlook');
    const mailboxes = outlook?.commands.find((c) => c.name() === 'mailboxes');
    expect(mailboxes).toBeDefined();
  });

  it('lists all mailboxes', async () => {
    const log_spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['outlook', 'mailboxes'], { from: 'user' });

    expect(mock_discovery.list_tenant_mailboxes).toHaveBeenCalledWith('test-tenant', undefined);
    expect(log_spy).toHaveBeenCalled();
    log_spy.mockRestore();
  });

  it('passes --licensed-only flag', async () => {
    const log_spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['outlook', 'mailboxes', '--licensed-only'], { from: 'user' });

    expect(mock_discovery.list_tenant_mailboxes).toHaveBeenCalledWith('test-tenant', {
      licensed_only: true,
    });
    log_spy.mockRestore();
  });

  it('reports the shared mailbox count in the summary line', async () => {
    vi.mocked(mock_discovery.list_tenant_mailboxes).mockResolvedValue([
      make_mailbox('alice@t.com'),
      make_mailbox('team@t.com', false, 'shared'),
    ]);
    const log_spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['outlook', 'mailboxes'], { from: 'user' });

    const logged = log_spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('2 mailbox(es) found (1 Exchange-licensed, 1 shared)');
    log_spy.mockRestore();
  });

  it('names every archive-enabled mailbox, because its archive is not backed up', async () => {
    vi.mocked(mock_discovery.list_tenant_mailboxes).mockResolvedValue([
      { ...make_mailbox('alice@t.com'), has_in_place_archive: true },
      { ...make_mailbox('bob@t.com'), has_in_place_archive: false },
      { ...make_mailbox('carol@t.com'), has_in_place_archive: true },
    ]);
    const warn_spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log_spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['outlook', 'mailboxes'], { from: 'user' });

    const warned = warn_spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warned).toContain('2 mailbox(es) have an In-Place Archive');
    expect(warned).toContain('alice@t.com');
    expect(warned).toContain('carol@t.com');
    expect(warned).not.toContain('bob@t.com');
    warn_spy.mockRestore();
    log_spy.mockRestore();
  });

  it('stays silent when no mailbox has an archive', async () => {
    vi.mocked(mock_discovery.list_tenant_mailboxes).mockResolvedValue([
      { ...make_mailbox('alice@t.com'), has_in_place_archive: false },
    ]);
    const warn_spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log_spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['outlook', 'mailboxes'], { from: 'user' });

    const warned = warn_spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warned).not.toContain('In-Place Archive');
    warn_spy.mockRestore();
    log_spy.mockRestore();
  });

  it('says nothing about archives when the report never reported their state', async () => {
    // Unknown must not render as "no archive": that is the false reassurance
    // issue #46 is about. The default fixture carries no archive field at all.
    const warn_spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log_spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['outlook', 'mailboxes'], { from: 'user' });

    const warned = warn_spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warned).not.toContain('In-Place Archive');
    warn_spy.mockRestore();
    log_spy.mockRestore();
  });
});

describe('format_in_place_archive', () => {
  it('renders a known archive state', () => {
    expect(format_in_place_archive(true)).toBe('Yes');
    expect(format_in_place_archive(false)).toBe('No');
  });

  it('renders unknown as -- rather than No', () => {
    // Reports.Read.All is optional, so "could not check" must never read as
    // "no archive" (issue #46).
    expect(format_in_place_archive(undefined)).toBe('--');
  });
});
