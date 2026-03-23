import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { Container } from 'inversify';
import 'reflect-metadata';
import { register_mailboxes_command } from '@/cli/commands/mailboxes.command';
import { MAILBOX_DISCOVERY_TOKEN } from '@/ports/tokens/outgoing.tokens';
import { ATLAS_CONFIG_TOKEN } from '@/utils/config';
import type { MailboxDiscoveryService, TenantMailbox } from '@/ports/mailbox/discovery.port';

function make_mailbox(mail: string, licensed = true): TenantMailbox {
  return {
    user_id: `uid-${mail}`,
    mail,
    display_name: mail.split('@')[0]!,
    has_exchange_license: licensed,
    exchange_plan_status: licensed ? 'Enabled' : undefined,
  };
}

describe('register_mailboxes_command', () => {
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
    register_mailboxes_command(program, () => container);
  });

  it('registers the mailboxes subcommand', () => {
    const sub = program.commands.find((c) => c.name() === 'mailboxes');
    expect(sub).toBeDefined();
  });

  it('lists all mailboxes', async () => {
    const log_spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['mailboxes'], { from: 'user' });

    expect(mock_discovery.list_tenant_mailboxes).toHaveBeenCalledWith('test-tenant', undefined);
    expect(log_spy).toHaveBeenCalled();
    log_spy.mockRestore();
  });

  it('passes --licensed-only flag', async () => {
    const log_spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['mailboxes', '--licensed-only'], { from: 'user' });

    expect(mock_discovery.list_tenant_mailboxes).toHaveBeenCalledWith('test-tenant', {
      licensed_only: true,
    });
    log_spy.mockRestore();
  });
});
