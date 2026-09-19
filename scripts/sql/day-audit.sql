-- Day audit: missed streams and missed minutes for one broadcast day (read-only).
-- Usage (on the server):
--   psql -X "$DATABASE_URL" -v day=<broadcast_day uuid> -v sid=<series uuid> -v w0='2026-09-18 22:00:00+00' -v w1='2026-09-19 03:00:00+00' \
--        -v kw='(\mpas\M|pubg americas|watch ?party)' -v tracker=04a2778a-107b-483d-aab3-5c86f783708b -v official=pubg_battlegrounds -f scripts/sql/day-audit.sql
-- w0/w1 bound the Discover readings that are loaded; kw is a case-insensitive regex for event wording in stream titles;
-- tracker is the Discover game tracker to compare with; official is the Twitch login whose Discover span defines the official broadcast.
\pset pager off
SET statement_timeout = '600s';
\echo ==== DAY :day
SELECT label, status, to_char(broadcast_start,'YYYY-MM-DD HH24:MI') AS start_utc, to_char(broadcast_end,'YYYY-MM-DD HH24:MI') AS end_utc FROM broadcast_days WHERE id = :'day';
CREATE TEMP TABLE dg AS
  SELECT g.channel_id, g.timestamp, g.concurrent_viewers AS ccv, g.stream_title AS title, g.stream_id, g.platform
    FROM game_tracker_snapshots g
   WHERE g.game_tracker_id = :'tracker' AND g.timestamp >= :'w0' AND g.timestamp < :'w1' AND g.concurrent_viewers > 0;
ANALYZE dg;
CREATE TEMP TABLE ref AS
  SELECT min(t.timestamp) AS t0, max(t.timestamp) + interval '1 minute' AS t1, count(DISTINCT date_trunc('minute', t.timestamp)) AS minutes
    FROM dg t JOIN channels gc ON gc.id = t.channel_id WHERE gc.platform = 'twitch' AND lower(gc.channel_identifier) = lower(:'official');
\echo == A. official Twitch channel span in Discover (UTC)
SELECT to_char(t0,'HH24:MI') AS official_start, to_char(t1,'HH24:MI') AS official_end, minutes FROM ref;
\echo == A2. official channels: tracker span vs Discover span
SELECT c.platform, left(c.display_name,22) AS name, to_char(min(v.timestamp),'HH24:MI') AS first_row, to_char(max(v.timestamp),'HH24:MI') AS last_row, count(DISTINCT date_trunc('minute', v.timestamp)) AS live_min, max(v.concurrent_viewers) AS peak,
   (SELECT to_char(min(t.timestamp),'HH24:MI')||'-'||to_char(max(t.timestamp),'HH24:MI')||' peak '||max(t.ccv) FROM dg t JOIN channels gc ON gc.id=t.channel_id WHERE lower(gc.platform::text)=lower(c.platform::text) AND lower(regexp_replace(gc.channel_identifier,'^@',''))=lower(regexp_replace(c.channel_identifier,'^@',''))) AS discover_span
 FROM viewership_snapshots v JOIN channels c ON c.id=v.channel_id WHERE v.broadcast_day_id=:'day' AND c.tier='official' AND v.concurrent_viewers>0 GROUP BY c.platform, c.display_name, c.channel_identifier ORDER BY 1,2;
\echo == B. minutes inside the day window with no rows at all (tracker silent)
WITH d AS (SELECT broadcast_start AS s, least(broadcast_end, (SELECT max(timestamp) FROM viewership_snapshots WHERE broadcast_day_id=:'day')) AS e FROM broadcast_days WHERE id=:'day'),
g AS (SELECT generate_series(date_trunc('minute',d.s), date_trunc('minute',d.e), interval '1 minute') AS m FROM d)
SELECT count(*) AS silent_n, string_agg(to_char(g.m,'HH24:MI'), ' ' ORDER BY g.m) AS silent_minutes FROM g WHERE NOT EXISTS (SELECT 1 FROM viewership_minute_rollup r WHERE r.broadcast_day_id=:'day' AND r.minute_bucket=g.m);
\echo == B2. per-minute live-channel count: minutes where the count drops by 3+ vs a neighbour (possible outage)
WITH m AS (SELECT r.minute_bucket AS m, count(*) FILTER (WHERE r.ccv>0) AS live_ch, count(*) AS ch, sum(r.ccv) AS total FROM viewership_minute_rollup r WHERE r.broadcast_day_id=:'day' GROUP BY 1),
x AS (SELECT m.*, lag(live_ch) OVER (ORDER BY m) AS prev_live, lead(live_ch) OVER (ORDER BY m) AS next_live FROM m)
SELECT to_char(m,'HH24:MI') AS minute, prev_live, live_ch, next_live, ch AS rows_ch, total FROM x WHERE live_ch <= prev_live - 3 OR live_ch <= next_live - 3 ORDER BY m;
\echo == B3. half-hour summary: live channels (min/avg), total (min/max)
SELECT to_char(date_trunc('hour', m) + (extract(minute FROM m)::int/30)*interval '30 minutes','HH24:MI') AS half_hour, min(live_ch) AS min_live, round(avg(live_ch),1) AS avg_live, min(total) AS min_total, max(total) AS max_total, count(*) AS minutes
  FROM (SELECT r.minute_bucket AS m, count(*) FILTER (WHERE r.ccv>0) AS live_ch, sum(r.ccv) AS total FROM viewership_minute_rollup r WHERE r.broadcast_day_id=:'day' GROUP BY 1) q GROUP BY 1 ORDER BY 1;
\echo == C. per-channel coverage inside the live span: missing (no row) and zero minutes, with runs
WITH r AS (SELECT r.channel_id, r.minute_bucket AS m, r.ccv FROM viewership_minute_rollup r WHERE r.broadcast_day_id=:'day'),
span AS (SELECT channel_id, min(m) AS t0, max(m) AS t1, max(ccv) AS peak FROM r WHERE ccv>0 GROUP BY 1),
grid AS (SELECT s.channel_id, g.minute FROM span s CROSS JOIN LATERAL generate_series(s.t0, s.t1, interval '1 minute') g(minute)),
j AS (SELECT grid.channel_id, grid.minute, r.ccv FROM grid LEFT JOIN r ON r.channel_id=grid.channel_id AND r.m=grid.minute),
bad AS (SELECT channel_id, minute, ccv, minute - (row_number() OVER (PARTITION BY channel_id ORDER BY minute)) * interval '1 minute' AS grp FROM j WHERE ccv IS NULL OR ccv=0),
runs AS (SELECT channel_id, min(minute) AS m0, max(minute) AS m1, count(*) AS n, count(*) FILTER (WHERE ccv=0) AS zeros FROM bad GROUP BY channel_id, grp)
SELECT c.platform, left(c.display_name,18) AS name, c.tier, to_char(s.t0,'HH24:MI') AS live_from, to_char(s.t1,'HH24:MI') AS live_to, (extract(epoch FROM (s.t1-s.t0))/60+1)::int AS span_min, s.peak,
       coalesce(sum(ru.n),0) AS bad_min, coalesce(sum(ru.zeros),0) AS zero_min,
       left(string_agg(to_char(ru.m0,'HH24:MI')||'-'||to_char(ru.m1,'HH24:MI')||'('||ru.n||CASE WHEN ru.zeros>0 THEN ',z'||ru.zeros ELSE '' END||')', ' ' ORDER BY ru.m0), 90) AS bad_runs
  FROM span s JOIN channels c ON c.id=s.channel_id LEFT JOIN runs ru ON ru.channel_id=s.channel_id
 GROUP BY 1,2,3,4,5,6,7 ORDER BY bad_min DESC, s.peak DESC;
\echo == D. tracked channels: tracker first/last row vs Discover first/last sighting with event wording (late starts / early ends flagged)
WITH tr AS (
  SELECT v.channel_id, min(v.timestamp) AS first_row, max(v.timestamp) AS last_row, max(v.concurrent_viewers) AS peak
    FROM viewership_snapshots v WHERE v.broadcast_day_id=:'day' AND v.concurrent_viewers > 0 GROUP BY 1),
disc AS (
  SELECT lower(gc.platform::text) AS platform, lower(regexp_replace(gc.channel_identifier,'^@','')) AS ident, min(t.timestamp) AS first_any, max(t.timestamp) AS last_any,
         min(t.timestamp) FILTER (WHERE t.title ~* :'kw') AS first_match, max(t.timestamp) FILTER (WHERE t.title ~* :'kw') AS last_match, max(t.ccv) AS disc_peak
    FROM dg t JOIN channels gc ON gc.id = t.channel_id GROUP BY 1,2)
SELECT c.platform, left(c.display_name, 18) AS name, c.source, c.tier, to_char(tr.first_row,'HH24:MI') AS first_row, to_char(tr.last_row,'HH24:MI') AS last_row, tr.peak,
       to_char(disc.first_match,'HH24:MI') AS disc_first_match, to_char(disc.last_match,'HH24:MI') AS disc_last_match, to_char(disc.first_any,'HH24:MI') AS disc_first_any, to_char(disc.last_any,'HH24:MI') AS disc_last_any, disc.disc_peak,
       CASE WHEN disc.first_match IS NOT NULL AND tr.first_row > greatest(disc.first_match, (SELECT t0 FROM ref)) + interval '3 minutes' THEN round(extract(epoch FROM (tr.first_row - greatest(disc.first_match, (SELECT t0 FROM ref))))/60)::int END AS late_min,
       CASE WHEN disc.last_match IS NOT NULL AND tr.last_row + interval '3 minutes' < least(disc.last_match, (SELECT t1 FROM ref)) THEN round(extract(epoch FROM (least(disc.last_match, (SELECT t1 FROM ref)) - tr.last_row))/60)::int END AS early_end_min
  FROM tr JOIN channels c ON c.id = tr.channel_id
  LEFT JOIN disc ON disc.platform = lower(c.platform::text) AND disc.ident = lower(regexp_replace(c.channel_identifier, '^@', ''))
 ORDER BY late_min DESC NULLS LAST, early_end_min DESC NULLS LAST, tr.peak DESC;
\echo == E. Sweep: Discover channels in the window with event wording, NOT tracked on this day
WITH tracked AS (SELECT DISTINCT lower(c.platform::text) AS platform, lower(regexp_replace(c.channel_identifier, '^@', '')) AS ident FROM viewership_snapshots v JOIN channels c ON c.id = v.channel_id WHERE v.broadcast_day_id=:'day' AND v.concurrent_viewers > 0)
SELECT gc.platform, gc.channel_identifier AS ident, left(max(gc.display_name), 18) AS name, max(gc.language) AS lang, count(DISTINCT date_trunc('minute', t.timestamp)) AS minutes, max(t.ccv) AS peak,
       to_char(min(t.timestamp),'HH24:MI') AS first, to_char(max(t.timestamp),'HH24:MI') AS last, left((array_agg(t.title ORDER BY t.ccv DESC))[1], 70) AS title,
       coalesce((SELECT c.source::text || '/' || c.tier::text || '/' || CASE WHEN c.is_active THEN 'on' ELSE 'off' END FROM channels c WHERE c.series_id=:'sid' AND c.platform = gc.platform AND lower(regexp_replace(c.channel_identifier,'^@','')) = lower(regexp_replace(gc.channel_identifier,'^@','')) LIMIT 1), 'NOT IN SERIES') AS roster_state
  FROM dg t JOIN channels gc ON gc.id = t.channel_id
 WHERE t.title ~* :'kw' AND t.timestamp >= (SELECT t0 FROM ref) - interval '15 minutes' AND t.timestamp < (SELECT t1 FROM ref) + interval '15 minutes'
   AND NOT EXISTS (SELECT 1 FROM tracked x WHERE x.platform = lower(gc.platform::text) AND x.ident = lower(regexp_replace(gc.channel_identifier, '^@', '')))
 GROUP BY gc.platform, gc.channel_identifier HAVING max(t.ccv) >= 3 ORDER BY peak DESC LIMIT 50;
\echo == E2. Sweep: biggest untracked Discover channels in the official span regardless of wording (peak >= 150), for eyeballing
WITH tracked AS (SELECT DISTINCT lower(c.platform::text) AS platform, lower(regexp_replace(c.channel_identifier, '^@', '')) AS ident FROM viewership_snapshots v JOIN channels c ON c.id = v.channel_id WHERE v.broadcast_day_id=:'day' AND v.concurrent_viewers > 0)
SELECT gc.platform, gc.channel_identifier AS ident, max(gc.language) AS lang, count(DISTINCT date_trunc('minute', t.timestamp)) AS minutes, max(t.ccv) AS peak, to_char(min(t.timestamp),'HH24:MI') AS first, to_char(max(t.timestamp),'HH24:MI') AS last,
       left(string_agg(DISTINCT left(t.title,45), ' | '), 110) AS titles
  FROM dg t JOIN channels gc ON gc.id = t.channel_id
 WHERE t.timestamp >= (SELECT t0 FROM ref) AND t.timestamp < (SELECT t1 FROM ref)
   AND NOT EXISTS (SELECT 1 FROM tracked x WHERE x.platform = lower(gc.platform::text) AND x.ident = lower(regexp_replace(gc.channel_identifier, '^@', '')))
 GROUP BY gc.platform, gc.channel_identifier HAVING max(t.ccv) >= 150 ORDER BY peak DESC LIMIT 40;
\echo == F. series channels with NO live rows on this day but seen live in Discover inside the window (with title)
SELECT c.platform, left(c.display_name,18) AS name, c.tier, c.is_active AS on, c.source, count(DISTINCT date_trunc('minute',t.timestamp)) AS disc_min, max(t.ccv) AS disc_peak, to_char(min(t.timestamp),'HH24:MI') AS first, to_char(max(t.timestamp),'HH24:MI') AS last, left((array_agg(t.title ORDER BY t.ccv DESC))[1],60) AS title
  FROM dg t JOIN channels gc ON gc.id=t.channel_id
  JOIN channels c ON c.series_id=:'sid' AND lower(c.platform::text)=lower(gc.platform::text) AND lower(regexp_replace(c.channel_identifier,'^@',''))=lower(regexp_replace(gc.channel_identifier,'^@',''))
 WHERE NOT EXISTS (SELECT 1 FROM viewership_snapshots v WHERE v.channel_id=c.id AND v.broadcast_day_id=:'day' AND v.concurrent_viewers>0)
 GROUP BY 1,2,3,4,5 ORDER BY disc_peak DESC;
\echo == G. Scout rows of this series last seen inside the window (metadata.last_seen_at), by tier: live minutes on this day, tracker peak, Discover peak
SELECT c.platform, left(c.display_name,18) AS name, c.tier, c.is_active AS on, to_char((c.metadata->>'last_seen_at')::timestamptz,'HH24:MI') AS last_seen, (c.metadata->>'discovered_ccv')::int AS disc_ccv,
  (SELECT count(DISTINCT date_trunc('minute', v.timestamp)) FROM viewership_snapshots v WHERE v.channel_id=c.id AND v.broadcast_day_id=:'day' AND v.concurrent_viewers>0) AS live_min,
  (SELECT max(v.concurrent_viewers) FROM viewership_snapshots v WHERE v.channel_id=c.id AND v.broadcast_day_id=:'day') AS peak,
  (SELECT max(t.ccv) FROM dg t JOIN channels gc ON gc.id=t.channel_id WHERE lower(gc.platform::text)=lower(c.platform::text) AND lower(regexp_replace(gc.channel_identifier,'^@',''))=lower(regexp_replace(c.channel_identifier,'^@',''))) AS disc_peak,
  left(c.metadata->>'stream_title', 60) AS title
  FROM channels c WHERE c.series_id=:'sid' AND c.source='auto_discovered' AND (c.metadata->>'last_seen_at')::timestamptz >= :'w0' AND (c.metadata->>'last_seen_at')::timestamptz < :'w1'::timestamptz + interval '12 hours' ORDER BY c.tier, peak DESC NULLS LAST;
\echo == H. rows after the official end / before the official start (trailing or leading data), per platform
SELECT c.platform, count(DISTINCT v.channel_id) AS channels, count(*) AS rows, to_char(min(v.timestamp),'HH24:MI') AS first, to_char(max(v.timestamp),'HH24:MI') AS last, max(v.concurrent_viewers) AS peak
  FROM viewership_snapshots v JOIN channels c ON c.id=v.channel_id WHERE v.broadcast_day_id=:'day' AND v.concurrent_viewers>0 AND v.timestamp >= (SELECT t1 FROM ref) GROUP BY 1 ORDER BY 1;
