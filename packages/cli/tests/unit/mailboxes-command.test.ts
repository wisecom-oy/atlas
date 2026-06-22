import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { Container } from 'inversify';
import 'reflect-metadata';
import { register_outlook_command } from '@/commands/outlook.command';
import { MAILBOX_DISCOVERY_TOKEN } from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import type { MailboxDiscoveryService, TenantMailbox } from '@wisecom/atlas-types';

function make_mailbox(mail: string, licensed = true): TenantMailbox {
  return {
    user_id: `uid-${mail}`,
    mail,
    display_name: mail.split('@')[0]!,
    has_exchange_license: licensed,
    exchange_plan_status: licensed ? 'Enabled' : undefined,
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
});
