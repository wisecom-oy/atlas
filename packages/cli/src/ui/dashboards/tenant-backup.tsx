import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { useSyncExternalStore } from 'react';
import { format_duration } from '@wisecom/atlas-core/services/shared/progress-rate';
import type { MailboxSlot, TenantBackupStore } from '@/ui/dashboards/tenant-backup-store';

const SEPARATOR_WIDTH = 63;

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '~' : text;
}

function SlotLine({ slot }: { slot: MailboxSlot | undefined }): ReactElement {
  if (!slot) {
    return <Text color="gray">{'[  ] --'}</Text>;
  }
  const owner_label = truncate(slot.owner_id, 30).padEnd(32);
  const folder = slot.folder_name ? truncate(slot.folder_name, 14) : '';
  const pct_str = slot.pct > 0 ? ` ${slot.pct}%` : '';
  const detail = (folder + pct_str).padEnd(18);
  return <Text color="cyan">{`[>>] ${owner_label}${detail}| ${slot.rate.toFixed(1)} msg/s`}</Text>;
}

/**
 * Fixed-height tenant backup dashboard: overall header, one row per
 * concurrent worker slot, and a done/error/pending summary footer.
 */
export function TenantBackupView({ store }: { store: TenantBackupStore }): ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.get_snapshot);

  const completed = state.done + state.errors;
  const eta_str = state.eta_seconds > 0 ? format_duration(state.eta_seconds) : '--';

  return (
    <Box flexDirection="column">
      <Text bold>
        {`Atlas Tenant Backup -- ${completed}/${state.mailbox_count} mailboxes` +
          ` | ${state.rate.toFixed(1)} msg/s | ETA ${eta_str}`}
      </Text>
      <Text color="gray">{'-'.repeat(SEPARATOR_WIDTH)}</Text>
      {state.slots.map((slot, index) => (
        <SlotLine key={index} slot={slot} />
      ))}
      <Text color="gray">{'-'.repeat(SEPARATOR_WIDTH)}</Text>
      <Text>
        <Text color="green">{`[ok] ${state.done} done`}</Text>
        {state.errors > 0 ? <Text color="red">{`  [!!] ${state.errors} error`}</Text> : undefined}
        <Text color="gray">{`  [  ] ${state.pending} pending`}</Text>
      </Text>
      {state.status_message === '' ? undefined : <Text color="yellow">{state.status_message}</Text>}
    </Box>
  );
}
