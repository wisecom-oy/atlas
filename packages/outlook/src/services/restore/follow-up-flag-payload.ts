import type { FollowUpFlag, ZonedDateTime } from '@wisecom/atlas-types';

/** Graph's `dateTimeTimeZone` shape. */
interface GraphDateTimeTimeZone {
  readonly dateTime: string;
  readonly timeZone: string;
}

/** Converts a recorded time back to Graph's `dateTimeTimeZone`. */
function to_graph_date_time(value: ZonedDateTime): GraphDateTimeTimeZone {
  return { dateTime: value.date_time, timeZone: value.time_zone };
}

/** Builds the Graph `flag` a create-message call accepts from the flag recorded at backup. */
export function to_graph_follow_up_flag(flag: FollowUpFlag): Record<string, unknown> {
  return {
    flagStatus: flag.status,
    ...(flag.start ? { startDateTime: to_graph_date_time(flag.start) } : {}),
    ...(flag.due ? { dueDateTime: to_graph_date_time(flag.due) } : {}),
    ...(flag.completed ? { completedDateTime: to_graph_date_time(flag.completed) } : {}),
  };
}
