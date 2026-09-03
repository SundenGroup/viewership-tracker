# TikTok viewer tracking from the server

Date: 2026-09-03. Status: implemented, deploys with the 21:00 UTC rollout after GeoGuessr WC Day 2.

## Why

Until now TikTok viewer counts came only from residential machines:

| Machine | Job | Problem |
|---|---|---|
| Relay MacBook (home network) | page-scrape relay, hard-coded PUBG list; TikTok category discovery for Discover; a WebSocket/DOM tracker | the DOM tracker reported the page-load count forever ("1" all of Day 1, a flat 728 for hours on Day 2); the scrape list did not include GeoGuessr |
| Simon's work Mac | page-scrape relay (launchd) with GeoGuessr added by hand on Day 2 | a laptop that is closed or on the wrong network means no TikTok data |
| Server | merged pushes with "highest value per minute wins" | a frozen 728 beat live readings of 150 |

Measured on 2026-09-03: the server reads TikTok's live page directly (HTTP 200, 213 KB, 0.4 s) and through the IPRoyal residential proxy already configured for the Kick resolver, and its `liveRoomStats.userCount` matched the residential scrape to the viewer in three of four minutes (838/838, 870/870, 942/942; 893 vs 884 seconds apart).

## What runs now

- `src/services/tiktok-server-tracker.ts`: every 60 s, for every active TikTok channel on a series with a live day (same query the relays use), fetch the live page directly; on a network error, non-200, or a page without room data, retry through `TIKTOK_PROXY_URL` (falls back to `KICK_PROXY_URL`). Live pages become readings tagged `server-page`; offline pages are a real zero; failed fetches write nothing. Five consecutive all-failed passes raise a `data_anomaly` notification ("TikTok tracking silent"). `TIKTOK_SERVER_TRACKER=0` disables it.
- `src/services/tiktok-ingest.ts`: the one ingest path for the relay endpoint and the server tracker: value validation, the plunge guard, the stale-source rule (a source repeating the identical value for 5 minutes while another source moved is ignored), and the source-ranked merge (`src/utils/tiktok-merge.ts`: WebSocket readings > page fetches > browser DOM; equal rank keeps the larger value; untagged relays count as page fetches).
- `src/utils/tiktok-live-page.ts`: the page parser (status 2 = live, `liveRoomStats.userCount`), with `unusable` for non-channel pages.
- Relay scripts tag their pushes (`source: 'page-scrape'` from `scripts/tiktok-relay.ts`, `browser-ws` / `browser-dom` from the browser tracker). The browser tracker also reloads the page before every DOM read and treats five identical reads as stale (`scripts/lib/tiktok-ws-client.ts`).

## Operating notes

- The residential relays are now optional. The Mac relay can be unloaded once the server has run a full broadcast day cleanly (`launchctl unload -w ~/Library/LaunchAgents/com.clutch.tiktok-relay.plist`).
- TikTok category discovery for Discover still runs on the Relay MacBook (it needs a real Chrome for TikTok's signed category feed); moving it is a separate step.
- The Windows PC stays Twitch-only.
- Health: `[TikTokServer] N/M live (direct x, proxy y, failed z) — @channel=viewers …` once a minute in the app log; `[TikTokIngest] … ignored as stale` when the stale rule fires.
