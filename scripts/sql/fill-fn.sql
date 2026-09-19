-- Session-local helpers (pg_temp) for back-fills from Discover readings: copy_discover, copy_discover_re (regex title filter),
-- fill_gaps (linear interpolation of short holes, never zero), breadcrumb (notes the fill on the channel), pin, assert.
-- Usage: \i this file inside a psql session, then call the functions inside ONE transaction with count asserts.
-- Session-local helper functions (pg_temp) for the 2026-09-14 back-fills.
CREATE FUNCTION pg_temp.fill_gaps(p_channel uuid, p_day uuid, p_maxrun int, p_t0 timestamptz, p_t1 timestamptz) RETURNS int LANGUAGE plpgsql AS $fn$
DECLARE n int;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _r (m timestamptz, ccv int) ON COMMIT DROP; TRUNCATE _r;
  INSERT INTO _r SELECT minute_bucket, ccv FROM viewership_minute_rollup WHERE channel_id=p_channel AND broadcast_day_id=p_day AND minute_bucket >= p_t0 AND minute_bucket <= p_t1;
  CREATE TEMP TABLE IF NOT EXISTS _ins (ts timestamptz, ccv int) ON COMMIT DROP; TRUNCATE _ins;
  INSERT INTO _ins
  WITH span AS (SELECT min(m) AS t0, max(m) AS t1 FROM _r WHERE ccv>0),
  missing AS (SELECT g.minute FROM span s CROSS JOIN LATERAL generate_series(s.t0, s.t1, interval '1 minute') g(minute) WHERE NOT EXISTS (SELECT 1 FROM _r WHERE _r.m=g.minute AND _r.ccv>0)),
  runs AS (SELECT min(minute) AS m0, max(minute) AS m1, count(*) AS n FROM (SELECT minute, minute - (row_number() OVER (ORDER BY minute))*interval '1 minute' AS grp FROM missing) x GROUP BY grp),
  fr AS (SELECT ru.*, b.m AS tb, b.ccv AS vb, a.m AS ta, a.ccv AS va FROM runs ru
           JOIN LATERAL (SELECT m, ccv FROM _r WHERE _r.m < ru.m0 AND ccv>0 ORDER BY m DESC LIMIT 1) b ON true
           JOIN LATERAL (SELECT m, ccv FROM _r WHERE _r.m > ru.m1 AND ccv>0 ORDER BY m ASC LIMIT 1) a ON true
          WHERE ru.n <= p_maxrun)
  SELECT g.minute + interval '30 seconds', greatest(1, round(f.vb + (f.va - f.vb) * extract(epoch FROM (g.minute - f.tb)) / extract(epoch FROM (f.ta - f.tb))))::int
    FROM fr f CROSS JOIN LATERAL generate_series(f.m0, f.m1, interval '1 minute') g(minute);
  INSERT INTO viewership_snapshots (channel_id, broadcast_day_id, stage_id, series_id, timestamp, concurrent_viewers, platform, language, region, stream_id, stream_title)
    SELECT c.id, d.id, d.stage_id, d.series_id, i.ts, i.ccv, c.platform, c.language, c.region,
           (SELECT v.stream_id FROM viewership_snapshots v WHERE v.channel_id=c.id AND v.broadcast_day_id=d.id AND v.timestamp < i.ts AND v.concurrent_viewers>0 ORDER BY v.timestamp DESC LIMIT 1),
           (SELECT v.stream_title FROM viewership_snapshots v WHERE v.channel_id=c.id AND v.broadcast_day_id=d.id AND v.timestamp < i.ts AND v.concurrent_viewers>0 ORDER BY v.timestamp DESC LIMIT 1)
      FROM _ins i CROSS JOIN channels c CROSS JOIN broadcast_days d WHERE c.id=p_channel AND d.id=p_day;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;

-- copy Discover rows (one per minute, max ccv) for a platform/identifier into a day, bounded by [t0, t1)
CREATE FUNCTION pg_temp.copy_discover(p_channel uuid, p_day uuid, p_platform text, p_ident text, p_t0 timestamptz, p_t1 timestamptz, p_title_like text) RETURNS int LANGUAGE plpgsql AS $fn$
DECLARE n int;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _src (ts timestamptz, ccv int, stream_id text, stream_title text) ON COMMIT DROP; TRUNCATE _src;
  INSERT INTO _src
    SELECT DISTINCT ON (date_trunc('minute', g.timestamp)) g.timestamp, g.concurrent_viewers, g.stream_id, g.stream_title
      FROM game_tracker_snapshots g JOIN channels gc ON gc.id=g.channel_id
     WHERE g.game_tracker_id='04a2778a-107b-483d-aab3-5c86f783708b' AND gc.platform::text=p_platform AND lower(gc.channel_identifier)=lower(p_ident)
       AND g.timestamp >= p_t0 AND g.timestamp < p_t1 AND g.concurrent_viewers>0 AND (p_title_like IS NULL OR g.stream_title ILIKE p_title_like)
     ORDER BY date_trunc('minute', g.timestamp), g.concurrent_viewers DESC, g.timestamp;
  INSERT INTO viewership_snapshots (channel_id, broadcast_day_id, stage_id, series_id, timestamp, concurrent_viewers, platform, language, region, stream_id, stream_title)
    SELECT c.id, d.id, d.stage_id, d.series_id, s.ts, s.ccv, c.platform, c.language, c.region, s.stream_id, s.stream_title
      FROM _src s CROSS JOIN channels c CROSS JOIN broadcast_days d WHERE c.id=p_channel AND d.id=p_day;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;

CREATE FUNCTION pg_temp.breadcrumb(p_channel uuid, p_day text, p_rows int, p_interp int, p_source text) RETURNS void LANGUAGE sql AS $fn$
  UPDATE channels SET metadata = jsonb_set(coalesce(metadata,'{}'::jsonb), '{fills}', coalesce(metadata->'fills','[]'::jsonb) || jsonb_build_array(jsonb_build_object('at', now(), 'day', p_day, 'rows', p_rows, 'interpolated', p_interp, 'source', p_source))) WHERE id=p_channel;
$fn$;

CREATE FUNCTION pg_temp.pin(p_channel uuid, p_day uuid) RETURNS void LANGUAGE sql AS $fn$
  INSERT INTO channel_broadcast_days (id, channel_id, broadcast_day_id) VALUES (gen_random_uuid(), p_channel, p_day) ON CONFLICT DO NOTHING;
$fn$;

CREATE FUNCTION pg_temp.assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN IF NOT coalesce(p_ok, false) THEN RAISE EXCEPTION 'ASSERT FAILED: %', p_msg; END IF; END $fn$;

-- same as copy_discover, but the title filter is a regular expression (the event wording differs per channel)
CREATE FUNCTION pg_temp.copy_discover_re(p_channel uuid, p_day uuid, p_platform text, p_ident text, p_t0 timestamptz, p_t1 timestamptz, p_title_re text) RETURNS int LANGUAGE plpgsql AS $fn$
DECLARE n int;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _src2 (ts timestamptz, ccv int, stream_id text, stream_title text) ON COMMIT DROP; TRUNCATE _src2;
  INSERT INTO _src2
    SELECT DISTINCT ON (date_trunc('minute', g.timestamp)) g.timestamp, g.concurrent_viewers, g.stream_id, g.stream_title
      FROM game_tracker_snapshots g JOIN channels gc ON gc.id=g.channel_id
     WHERE g.game_tracker_id='04a2778a-107b-483d-aab3-5c86f783708b' AND gc.platform::text=p_platform AND lower(gc.channel_identifier)=lower(p_ident)
       AND g.timestamp >= p_t0 AND g.timestamp < p_t1 AND g.concurrent_viewers>0 AND g.stream_title ~* p_title_re
     ORDER BY date_trunc('minute', g.timestamp), g.concurrent_viewers DESC, g.timestamp;
  INSERT INTO viewership_snapshots (channel_id, broadcast_day_id, stage_id, series_id, timestamp, concurrent_viewers, platform, language, region, stream_id, stream_title)
    SELECT c.id, d.id, d.stage_id, d.series_id, s.ts, s.ccv, c.platform, c.language, c.region, s.stream_id, s.stream_title
      FROM _src2 s CROSS JOIN channels c CROSS JOIN broadcast_days d WHERE c.id=p_channel AND d.id=p_day;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;

