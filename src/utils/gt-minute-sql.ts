/**
 * How a minute of game-tracker viewership is totalled.
 *
 * A minute's total is every stream's MOST RECENT reading in that minute,
 * added up. It is never the sum of every row in the minute: a minute can
 * hold two polls (a poll that ran long and was stamped late, a restart, a
 * poll started by hand), a category listing can return one stream on two
 * result pages, and held YouTube rows are copied in later with their own
 * timestamps. Summing rows counted every channel twice in such a minute
 * and drew a spike of double height on the one-minute charts.
 *
 * Every reader that totals minutes (the bucket rollup, the raw timeline,
 * the breakdowns) builds on the two functions below so they cannot drift.
 */

/**
 * The reading with the latest timestamp inside a one-minute group, in one
 * integer MAX: milliseconds into the minute in the high digits, viewers in
 * the low eight. The latest row wins, and the higher value when two rows
 * share a millisecond. A single stream is assumed to stay under 100 million
 * viewers. (An array MAX reads better and costs twice the time on the
 * 6 hour chart of a large tracker.)
 */
export const LATEST_READING_SQL =
  `(MAX(date_part('milliseconds', "timestamp")::bigint * 100000000 + concurrent_viewers) % 100000000)`;

/** Language as the rollup stores it: lower case, '-' when a row has none. */
export const LANGUAGE_KEY_SQL = `COALESCE(NULLIF(LOWER(language), ''), '-')`;

/**
 * One row per stream and minute for a single scope (the timeline):
 * (minute, channel_id, stream_id, ccv). The minute leads the key so the
 * per-minute total that follows reuses the sort, and the stream id is
 * compared bytewise, which is all a grouping key needs.
 *
 * `where` is a SQL condition on game_tracker_snapshots with `?`
 * placeholders bound by the caller.
 */
export function perStreamMinuteSql(where: string): string {
  return `
      SELECT date_trunc('minute', "timestamp") AS minute,
             channel_id,
             stream_id COLLATE "C" AS stream_id,
             ${LATEST_READING_SQL} AS ccv
      FROM game_tracker_snapshots
      WHERE ${where}
      GROUP BY 1, 2, 3`;
}

/**
 * The same rows with the dimensions the rollup and the breakdowns split
 * by: (game_tracker_id, minute, platform, language, channel_id, stream_id,
 * ccv).
 */
export function perStreamMinuteByDimensionSql(where: string): string {
  return `
      SELECT game_tracker_id,
             date_trunc('minute', "timestamp") AS minute,
             platform::text AS platform,
             ${LANGUAGE_KEY_SQL} AS language,
             channel_id,
             stream_id COLLATE "C" AS stream_id,
             ${LATEST_READING_SQL} AS ccv
      FROM game_tracker_snapshots
      WHERE ${where}
      GROUP BY 1, 2, 3, 4, 5, 6`;
}
