import { describe, expect, it } from 'vitest';
import { graph_message_to_mail_message } from '@/adapters/graph-delta-message-mapper';

const DUE = { dateTime: '2026-11-20T00:00:00.0000000', timeZone: 'UTC' };
const START = { dateTime: '2026-11-10T00:00:00.0000000', timeZone: 'UTC' };

/** Issue #579: the delta item's `flag` was selected but never kept beside the MIME. */
describe('follow-up flag on a delta message', () => {
  it('keeps a flagged message status with its start and due dates', () => {
    const message = graph_message_to_mail_message({
      id: 'msg-1',
      flag: { flagStatus: 'flagged', startDateTime: START, dueDateTime: DUE },
    });

    expect(message.flag).toEqual({
      status: 'flagged',
      start: { date_time: START.dateTime, time_zone: 'UTC' },
      due: { date_time: DUE.dateTime, time_zone: 'UTC' },
    });
  });

  it('keeps a completed message with its completion date', () => {
    const message = graph_message_to_mail_message({
      id: 'msg-2',
      flag: { flagStatus: 'complete', completedDateTime: DUE },
    });

    expect(message.flag).toEqual({
      status: 'complete',
      completed: { date_time: DUE.dateTime, time_zone: 'UTC' },
    });
  });

  it('records no flag for a message that is not flagged or carries no flag field', () => {
    expect(
      graph_message_to_mail_message({ id: 'msg-3', flag: { flagStatus: 'notFlagged' } }),
    ).not.toHaveProperty('flag');
    expect(graph_message_to_mail_message({ id: 'msg-4' })).not.toHaveProperty('flag');
  });
});
