import type { TeamsGraphResource, TeamsMessageRef, TeamsThread } from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import {
  mark_message_removed,
  type MessageStoreOutcome,
  store_message,
} from '@/services/backup/message-store';

/** Result of storing one channel-root thread: the new thread and what was reused. */
export interface ThreadStoreResult {
  readonly thread: TeamsThread;
  readonly warnings: string[];
  /** Root and reply versions written with new content. */
  readonly stored: number;
  /** Root and reply versions reused unchanged from the previous run. */
  readonly deduped: number;
}

/**
 * Stores a channel-root thread from its root and the replies Graph returned. Each message gets its
 * own blob. Replies missing from `replies` are carried over from `previous`, because an empty
 * list means the replies were not read this run, not that they are gone.
 */
export async function store_thread(
  scope: BackupRunScope,
  channel_id: string,
  previous: TeamsThread | undefined,
  root: TeamsGraphResource,
  replies: TeamsGraphResource[],
): Promise<ThreadStoreResult> {
  const root_locator = { team_id: scope.team_id, channel_id, root_id: root.id };
  const root_outcome = await store_message(
    scope,
    root_locator,
    { root_id: root.id },
    previous?.root,
    root,
  );
  const outcomes: MessageStoreOutcome[] = [root_outcome];
  const reply_refs: Record<string, TeamsMessageRef> = {};
  for (const reply of replies) {
    const outcome = await store_message(
      scope,
      { ...root_locator, reply_id: reply.id },
      { root_id: root.id, reply_id: reply.id },
      previous?.replies[reply.id],
      reply,
    );
    outcomes.push(outcome);
    reply_refs[reply.id] = outcome.ref;
  }
  // ponytail: a reply Graph hard-deletes is never reported, so it stays live here forever. Upgrade when Graph exposes a reply removal signal.
  for (const [id, ref] of Object.entries(previous?.replies ?? {})) {
    if (!(id in reply_refs)) {
      reply_refs[id] = ref;
    }
  }
  return {
    thread: {
      root: root_outcome.ref,
      replies: reply_refs,
      deleted_at: root_outcome.ref.deleted_at,
    },
    warnings: outcomes.flatMap((outcome) => outcome.warnings),
    stored: outcomes.filter((outcome) => !outcome.deduped).length,
    deduped: outcomes.filter((outcome) => outcome.deduped).length,
  };
}

/**
 * Marks a thread's root removed when Graph reports the removal without a body. Replies are left
 * as they were, since they are not re-read.
 */
export function mark_root_removed(scope: BackupRunScope, previous: TeamsThread): TeamsThread {
  const root = mark_message_removed(scope, previous.root);
  return { ...previous, root, deleted_at: root.deleted_at };
}
