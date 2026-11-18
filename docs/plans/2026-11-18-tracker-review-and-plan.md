# Tracker review and improvement plan

Date: 2026-11-18. Scope: event tracking and its UI, reports, live event tracking, Explore and Ask, and Discover in depth. Nothing in production was changed during this review.

## How this was done

- Five independent code reviews ran in parallel, one per area. Each read whole files, not excerpts.
- The Discover backend, storage, deploy and repository layout were reviewed separately, with read-only checks against the production database and logs.
- The most serious claims from the five reviews were re-read in the code before they went into this document.

Marks used below: **prod** means measured in production today. No mark means confirmed by reading the code. *unverified* means plausible and not confirmed.

Not done: the screens were not looked at in a browser, because that needs a login. Screen findings come from the source. No load test was run.

Effort: S is under half a day, M is one to three days, L is more.

## 1. Verdict per area

| Area | State | Strongest part | Weakest part |
|------|-------|----------------|--------------|
| Event tracking and editor | Mature, with sharp edges | CSV import, Scout hardening, the minute rollup | Two ordinary editor actions lose data silently (V1, V2). A save is dozens of requests. Writes are neither validated nor role-checked. |
| Reports | Polished on top, fragile underneath | Views round-up, rollup-based headline numbers, export grains | A report is a live page, not a fixed snapshot. The same split is computed three ways. Public endpoints leak across series. |
| Live tracking | Robust wherever an incident already happened | Failure handling on Twitch, Kick and YouTube, the TikTok ingest, multi-stream binding | One slow platform delays all of them. Nobody is told when a source stops. An anonymous visitor can restart the process. |
| Explore and Ask | Strong design, heavy page | Ask picks from a closed list of intents and answers by changing the view | Series scope reads raw rows. Filters do not reach the chart. One 3,300 line page. |
| Discover | Good engine, thin product | Category reads down to a viewer floor, stream sessions, a health score that shows its evidence | Totals can be doubled. The health signal is missing where the audience is. The screens answer "now" and little else. Half the settings exist only in the database. |

## 2. Found live during the review

These exist in production today. None was changed. Each needs a yes before anything is touched.

| # | What | Evidence | Effect |
|---|------|----------|--------|
| U1 | Discover counts every channel twice in a minute that holds two poll cycles | **prod.** 7 doubled minutes on GTA VI in its first 5 hours, 2 to 3 a day on every other tracker. GTA VI's stored peak is 11,596,688 against about 5.8 million in the minutes around it. Detail in D1 and D2. | Peak figures are up to double. Averages of an affected 10 minute bucket are about 10% high. The 1 hour and 6 hour charts show the spike directly. |
| U2 | Kick chat collection has been dead since 2026-10-17 05:13 UTC | **prod.** Zero Kick rows in `chat_minute_rollup` after that minute. The collector log shows the Kick socket connecting, subscribing and being dropped every few seconds. | No Kick stream has had a health score for a month: 1,480 eligible sessions in November, 0 scored. On GTA VI that is about 430 channels and 1.28 million viewers. Nothing alerted anyone. |
| U3 | The disk does not fit GTA VI at 30 days of minute rows | **prod.** Disk 154 GB, 118 GB used. Database 53 GB, of which Discover minute rows are 37 GB. Five local backups of 11 GB take 55 GB. GTA VI adds about 2.5 million rows a day, close to 1 GB a day with indexes, and every backup copy grows with it. | Without a change the disk fills in roughly a week. The nightly backup stops first, then Postgres refuses connections, as on 2026-09-27. Detail in section 8.5. |
| U4 | An anonymous visitor can restart the tracker | The websocket message handler is async and is called with no catch (`websocket.ts:238`). A public `subscribe` with a series id that is not a UUID makes the database lookup reject (`websocket.ts:273`). The process counts unhandled rejections over its whole lifetime and shuts down at five (`index.ts:479`). `/ws` accepts anonymous connections. | Five malformed messages restart the app. The same path turns a short database hiccup into a restart when public pages are open. |
| U5 | Public pages serve non-public data | `parseScope` in `public.ts:105` checks only that a day or stage id looks like a UUID, not that it belongs to the public series in the address. The public websocket sends every subscriber the poll result of the whole cycle: total viewers and channel count across all live series, and raw error text (`websocket.ts:318`). | Anyone who knows a day or stage id of a private event can read its metrics and leaderboard through any public page. A visitor of a public page can read the combined audience of everything live. 15 series are public today. |
| U6 | Saving the series form erases SOOP from its Scout settings | `SeriesForm.tsx:538` rebuilds the Scout game ids from three fields (Twitch, YouTube, Kick) and sends the whole object. **prod:** PGSC4 is active and holds a SOOP id. | The next save of the PGSC4 form, even to rename a day, switches SOOP Scout off with no message. |
| U7 | Disable then Enable on an "all days" channel during a live day pins it to that day | `channels.ts:457` inserts a day pin for each live day on every re-enable, without checking that the channel had no pins. No pins is what "all days" means. | An official channel silently becomes a one day channel and is not recorded from the next day. The only hint is "1 day" in the Days column. |
| U8 | Series-wide views read raw rows, several at once, on a timer | **prod**, on PGSC4 (699,666 rollup rows): one grouped time series from raw rows takes 6.7 s on a quiet server. The same answer from the minute rollup takes 1.5 s, and 0.7 s at 10 minute grain. The editor, Explore, the report page and the public page each fire three of these plus seven series-wide aggregations every 30 to 60 seconds, on a pool of 10 connections. | This is the 40 second timeout that looks like an outage. Opening by stage or day does not avoid it on the report and public pages, which always fetch the series. Detail in X1. |
| U9 | A Discover cycle can overlap itself | A plain `setInterval` with no "already running" check (`game-tracker-service.ts:136`). **prod:** GTA VI cycles took 9 to 39 seconds over the last 20 runs, against a 60 second interval. Each matched channel costs one single-row UPDATE, about 1,650 a cycle. | One slow platform pushes a cycle past 60 seconds and two cycles then write side by side. This is also how U1 becomes frequent. |
| U10 | The health score reaches a small part of some games | **prod.** Share of live viewers on channels with a usable grade: Apex 79%, Overwatch 68%, PUBG 11%, GTA VI 0% so far. PUBG's largest platform is SOOP (304 of 462 live channels). SOOP, CHZZK and TikTok have no chat collection. Follower readings cover 116 of 1,904 live GTA VI channels. | The best part of Discover is silent where PUBG's audience is, and thin on GTA VI below the top channels. |
| U11 | 488 YouTube channels wait for review on PUBG | **prod.** 488 pending on PUBG, 11 on GeoGuessr. | Held streams are not counted until someone decides. The queue only grows. |
| U12 | TikTok category capture runs in a terminal tab on the work Mac | The Relay MacBook is offline. | TikTok numbers for all five trackers stop when that Mac sleeps. |
| U13 | A deploy hides a failed migration | `deploy/update.sh:56` prints "no pending migrations" on any migration error and restarts the app anyway. The app then runs migrations at boot and exits on failure, which under pm2 is a crash loop. | A broken migration takes the tracker down, mid-broadcast if the push lands then. |
| U14 | The legacy report writer pins a model from May 2025 | `report-agent.ts:140` uses `claude-sonnet-4-20250514`, which the API reference lists as retired in June 2026. Ask uses `claude-sonnet-5` (`ask/compiler.ts:17`). | The legacy static report most likely produces no commentary. Two model ids live in two places. |

## 3. One cause behind the slow pages

| # | Finding | Evidence | Fix | Effort |
|---|---------|----------|-----|--------|
| X1 | Time series by platform, language and tier read raw snapshots | `viewership.ts:268-313` and `public.ts:449-472` run a three level GROUP BY on `viewership_snapshots`. A rollup version exists (`viewership-snapshot.ts:527`) and only the legacy report calls it. The bucket size parameter is ignored: the expression always yields one minute (`viewership.ts:297`). | Route all grouped series through the rollup. Pick the grain from the span: one minute for a day, five for a stage, ten for a series. | M |
| X2 | Every page with a series id polls series-wide metrics | `App.tsx:223` and `usePublicPollingData.ts:46` fetch series metrics (seven aggregations, `viewership.ts:176`) every 30 seconds, including on Explore, the edit form and a day report, where nothing uses them. Polling never stops for a finished event or a hidden tab. | Fetch what the visible scope needs. Stop polling when no day in scope is live and when the tab is hidden. | S |
| X3 | A timeout is reported as a generic error and retried forever | `server.ts:147` turns a statement timeout into a 500. Errors are not cached (`public-cache.ts:149`), so the query is reissued every cycle. The old chart stays on screen under the new scope's label (`useApi.ts:42`). | Return a distinct "too much data for one view" answer, cache it briefly, clear the old data. | S |
| X4 | One pool of 10 connections serves poll writes and page reads | `utils/db.ts:7`. No acquire timeout. | A small separate pool for the poller, ingest and relay writes. A short acquire timeout on the read pool. | S |

## 4. Event tracking and its UI

Keep as it is: the minute rollup kept by a database trigger; the CSV import with preview, one transaction, DST-safe times and a clock-shift guard; Scout's hardening (normalised keys, off-schedule extension, name guard, purge that protects rows with data); the roster check and day QA; the response-race guard in the data hooks.

### 4.1 Bugs and data risks

| # | Finding | Evidence | Fix | Effort |
|---|---------|----------|-----|--------|
| V1 | Re-enabling an "all days" channel on a live day pins it to that day | See U7. `channels.ts:457-482`. | Add live-day pins only when the channel already has pins or was found by Scout. Longer term an explicit scope column instead of "no rows means all days". | S |
| V2 | The series form erases Scout ids it does not show | See U6. `SeriesForm.tsx:538-542`, `tournament-series.ts:92`. | Merge onto the stored object. Add SOOP and CHZZK fields to the form. | S |
| V3 | The editor always opens on the full series, and clicking a day does not change scope | `EditorDesktop.tsx:148` sets the scope before the series has loaded, so it is always "series". Schedule clicks only set the selected day (`:492`, `:567`). The breadcrumb shows the day and the KPI says "Peak today" (`:876`) over series-wide numbers. | Set the default scope after the load, make a schedule click set day scope, reset on series switch, label the KPI by scope. This also removes the heaviest query from every page open. | S |
| V4 | The editor never refreshes day status, and Extend works from a stale copy | The series is fetched once (`App.tsx:196`). The websocket's status message is stored and never read (`usePollingData.ts:86`). Extend computes the new end in the browser and sends an absolute time (`App.tsx:308`). | Refetch on the status message. A server-side "extend by N minutes" that never moves an end earlier and answers "not live" when the day already completed. | S |
| V5 | A series save is dozens of requests, and a retry after a partial failure creates duplicates | `SeriesForm.tsx:592-667`. Every save also rewrites the start and end of every existing day from the form's copy (`:639`), which reverts an end time extended since the form was opened. | One endpoint that takes the whole tree in one transaction and changes only what differs. | M |
| V6 | Metadata is overwritten whole from stale copies | The form sends the series metadata it loaded when the page opened (`SeriesForm.tsx:588`). That object also holds the Scout blocklist and the Scout resume flag. The channel row editor does the same (`ChannelsSection.tsx:491`). | Server-side merge of named keys only. | S to M |
| V7 | Deleting a day or stage orphans its data and turns day-pinned channels into all-days channels | Snapshot links are set to null on delete, pins are removed with the day, and the delete routes have no guard (`broadcast-days.ts:75`, `stages.ts:66`). The form's remove buttons ask nothing (`SeriesForm.tsx:436`). | Refuse to delete a day that has data unless an admin chooses "move the data to day X" or "delete the data". Confirm with row counts. | M |
| V8 | Channel identifiers are not put in one form, so near-duplicates count twice | A failed YouTube handle lookup stores the raw input and still answers "created" (`channels.ts:84-110`). Uniqueness is on the raw string, while the poller matches in lower case. **prod:** 2 such duplicate groups exist in event rosters today. | One canonical form per platform on every write path, a unique index on it, a refusal when the lookup fails, and a live check on add. | M |
| V9 | Day start and end side effects exist only on the automatic path | Automatic go-live purges the feed and starts Scout; automatic completion pauses day channels, stops Scout and tells other clients (`polling-orchestrator.ts:321-510`). The manual status route only purges (`broadcast-days.ts:88`). | One "day went live" and one "day completed" function, called from both paths. An explicit Reopen that sets status and end together. | M |
| V10 | Schedule times can be an hour off around a clock change | The browser converts local time in one pass (`formatters.ts:289`). A day that crosses midnight is shifted by a fixed 24 hours (`SeriesForm.tsx:646`). No tests. | Port the backend's two-pass conversion and add a table of tests for the March, October and November changes. | S |
| V11 | Scout review state is guessed from the category | "Approved" means "category is not Community" (`discovery-service.ts:538`), yet Community can be the default category. The phone editor has drifted from the desktop one and has no Unblock (`EditorMobile.tsx:892`). | An explicit review state column and one shared function for a row's state. | M |
| V12 | The Scout blocklist is one name across all platforms and disappears from view | Entries are bare names in series metadata. The purge at go-live deletes the blocked row while the entry stays, so it can no longer be listed or unblocked. | A blocklist table per series and platform, with a small list and Unblock in the Scout section. | M |
| V13 | Scout cycles can overlap and two steps grow with the series | No "already running" check (`discovery-service.ts:115`). Every disabled candidate is live-checked each cycle with no cap. The purge scans all raw rows of the series inside the poll cycle at go-live. | A running flag, a cap on live checks, and a purge that asks per candidate. | S to M |

### 4.2 Permissions

Today there are 2 admins and 3 editors, and no viewer accounts (**prod**), so the exposure is small. These matter the day a wider audience gets a login.

| # | Finding | Evidence | Fix | Effort |
|---|---------|----------|-----|--------|
| V14 | "Admins only" on a series is enforced in the list only | `requireSeriesAccess` exists (`auth.ts:119`) and is used nowhere. The detail, channel, day and viewership routes and the websocket do no check. | Apply it where a series id is in the route, and resolve the series for day, stage and channel ids. | S to M |
| V15 | Update routes write any column in the request | `update(id, req.body)` in the series, stage, day and channel routes. An editor can set status, public and minimum role. A wrong field is a bare 500. | A list of allowed fields per route and role. | M |
| V16 | The editor shows every control to every role and swallows errors | No role check in the editor components. Toggle, delete, row save and clear-all ignore failures (`ChannelsSection.tsx:157`, `DiscoveryFeedSection.tsx:289`). | One capabilities hook. Row-level error messages. | M |

### 4.3 Workflow and missing features

| # | Finding | Fix | Effort |
|---|---------|-----|--------|
| V17 | Scout review is one row at a time, and a candidate is not recorded until approved (the guide says it is) | Multi-select with bulk approve and block, filters by state, platform, language and viewers, a pending count. Larger step: bank a candidate's minutes and copy them on approval, as Discover's YouTube queue already does. | M, then L |
| V18 | Bulk add takes one platform, one language and one category for all lines, and reports a skipped count only | Paste a table or URLs, detect the platform from the URL, show a preview with the lookup and live-check result per line. | M |
| V19 | The channel list has no search or multi-select, language cannot be cleared, and "Promote to manual" exists only in dead code | Search and column filters, bulk edit with preview, a validated language picker, an explicit "All days" switch. | M |
| V20 | No way to clone a series, generate a schedule or carry a roster over | "Duplicate series" with a date shift in local time and an optional roster copy. "Add N days" from a date range. "Copy channels from series". PGSC4 was built by hand as a 70 day shift of Circuit 3: this is that, as a button. | M each |
| V21 | Destructive actions and accountability | Typed confirmation on every series delete, data counts in the confirm, a restore window for deleted channels and days, an audit table of who changed what. Guard against demoting the last admin. Keep form state when the session expires. | M |
| V22 | Times are shown in mixed zones | Peak time and the day window use the browser's zone while charts use the series zone. The import dialog defaults to Europe/Berlin. One formatter that takes the series zone and labels it. | S |

## 5. Reports

Keep as it is: the views round-up (tested math, measured and estimated kept apart, the completeness warning); export grains with "safe to sum" as the default; the comparison baseline with its visible badge; the single-flight cache.

How it is built today: the report the UI opens is a live React page that reads the public API on every open and keeps polling. A second, older path builds a static HTML file on the server with AI commentary. A third builds PDF, Word and Excel through Python and is reachable from no screen.

### 5.1 Correctness and trust

| # | Finding | Evidence | Fix | Effort |
|---|---------|----------|-----|--------|
| R1 | A report is a live page, while the guide promises a fixed snapshot | `docs/user-guide.md:107` says reports do not change when data is corrected. The export only builds a URL (`ExportDialog.tsx:533`) and the page refetches everything on each open. | A "publish" step that stores the report's numbers under a share id and renders from that, with a "data as of" date. The live page stays as the internal preview. | M to L |
| R2 | One report page computes the same split three ways | Headline and platform peaks come from the rollup. Tier and language peaks come from the raw grouped series (`ReportPage.tsx:1161-1240`). Hours by platform, language and tier are sums of per-channel hours already rounded (`useDashboardModel.ts:138`). The "Peak by language" table uses the rollup. | One server answer per scope with peak, average and viewer-minutes per platform, language and tier, all from the rollup. Delete the client-side rebuilds. | M |
| R3 | Average viewers and day counts depend on things the reader cannot see | The average covers every minute that has any row (`viewership-snapshot.ts:341`). Offline rostered channels write zero rows and Scout-found channels write none, so a channel's average and the day's average move with when the day was started. Day counts include days that have not happened (`ReportPage.tsx:758`). The tile labelled "Avg broadcast / day" shows hours watched. | Average over minutes inside the broadcast window, channel averages over live minutes, count days with data. Published numbers will move a little, so compare before and after on a few events first. | S to M |
| R4 | Public endpoints do not tie a day or stage id to the public series | See U5. Related: `/api/report-payload`, `/api/export` and the views routes serve any series by id to any signed-in role. | Resolve every id against the series in the address and answer "not found" otherwise. | S |
| R5 | A stale or ambiguous link silently shows another scope | An unmatched slug falls through to the whole series (`ReportPage.tsx:221`). Stage links use the stage's position, so reordering stages repoints old links. An unknown view group falls back to all channels. | Ids in links, and a plain "this report link is no longer valid". | S to M |
| R6 | The recipient can change what a shared link shows | Detail level, excluded channels, view group and "include views" are plain URL parameters (`ReportPage.tsx:77`). Removing one shows what was meant to be hidden. | The share id from R1 pins scope, filters and the views flag on the server. | with R1 |
| R7 | CSV and JSON exports ignore the view group and exclusions the dialog shows as applied | The export URL carries scope, id, grain and views only (`api.ts:748`). The dialog shows a file name the server does not use. A failed download is a tab of raw JSON. | Pass the filters, send the previewed name, download in place with an inline error. | S to M |
| R8 | Export files are unsafe and hard to open | Cells that start with =, +, - or @ are not neutralised, and stream titles are streamer-controlled. No byte order mark, so Korean, Thai and Vietnamese names break in Excel. Times are UTC only. Everything is built in memory. | Neutralise risky cells, add the mark, add a local-time column in the series zone, stream the rows. | S to M |
| R9 | The public recap compares a filtered period with an unfiltered one, and the phone page ignores the view group | `PublicPage.tsx:1046` against `:950`. `PublicMobile.tsx:552`. | Pass the filter in both places. | S |
| R10 | Labels and dates that mislead | "vs previous day" on a stage report. Today's date printed as the report date. A date range with no year. "Share of peak CCV" that shows live viewers while anything is live. "1000K" just below a million. | Fix the copy and the formatter. One "Data as of" line. | S |
| R11 | The legacy static report prints different numbers, and can run a script | It averages day averages, merges per-day top ten lists and labels the time zone by today's clock state (`report-agent.ts:1132`, `report-builder-html.ts:209`). Channel names go unescaped into a script block and the file is served from the app's own address (`report-builder-html.ts:387`). | Retire the path once R1 exists. Until then, escape names and serve the file sandboxed. | S now, M to retire |
| R12 | No rate limit on the public API, and the cache is optional for the caller | Only login is limited. The cache applies only with a matching referer and is skipped by a query flag (`public-cache.ts:81`). The public time series accepts "by channel" for a whole series. | Rate limit the public routes, always cache them, restrict the public grouping to platform, language and tier. | S |
| R13 | Views collection falls behind in busy weeks | The hourly run skips whenever any day in any series is live (`views-collector.ts:172`) and looks only at days ended in the last 10 days. | Skip only for the series that is live. Show "not collected" on the day in the editor. | S to M |

### 5.2 Workflow and missing features

| # | Finding | Fix | Effort |
|---|---------|-----|--------|
| R14 | From a finished day to a link in a partner's hands takes seven actions, and a report cannot be checked before the series is public | A "Share report" action on the day and stage headers that shows the link with a copy button first. A signed-in preview for non-public series. The same action on the phone editor. | M |
| R15 | No usable print or PDF | A print stylesheet (light, A4, sensible page breaks, the full leaderboard), a document title per report, a "Save as PDF" button. | M |
| R16 | No day-by-day figures inside a stage or series report | Make the hero's day segments real: one per day with data, sized by hours, peak on hover. Add "Peak at" to the existing leaderboard. Both stay inside the existing cards. | M |
| R17 | No record of what was shared | With R1: a "Shared reports" list per series with who, when, scope, link and revoke. | M |
| R18 | No partner or event logo, no link preview, no time window inside a day | An optional logo on the series, preview tags per share id, a start and end time on a published report (main show without pre-show). | M each |
| R19 | Dead and duplicated code: about 5,000 lines in `components/panels`, `components/sidebar` and `components/charts` are imported by nothing, and the Python PDF, Word and Excel pipeline is reachable from no screen. Scope resolution and language filtering each exist in several copies with different rules, so a "pt" view group includes pt-br in viewers and excludes it in views. | Delete after confirming nothing external calls the old endpoints. One scope resolver and one filter module. | S to M |
| R20 | The tests do not run the code that produces report numbers: `tests/integration/aggregation.test.ts` runs its own copy of an old query. | Tests through the rollup trigger and the model functions, a test that a foreign day id is refused, a CSV snapshot test. | M |

## 6. Live event tracking

Keep as it is: "unknown is not zero" where it exists (Twitch, Kick, Steam, YouTube); YouTube multi-stream binding by video id with its ownership gate; the TikTok ingest (one path, plunge guard, source ranking); relay value hygiene (tab-bleed and Stream Together detection); a kill switch for every background job.

### 6.1 Wrong data instead of no data

| # | Finding | Evidence | Fix | Effort |
|---|---------|----------|-----|--------|
| L1 | Zero rows on a failed fetch remain in four adapters and several paths | SOOP (`soop.ts:184`), CHZZK (`chzzk.ts:106`), Trovo (`trovo.ts:73`) and Nimo return "offline" when the request failed. An adapter that throws gives every channel an offline default (`adapters/index.ts:106`), and the poller then writes 0 for each rostered channel. A YouTube @handle that fails to resolve after a restart does the same (`youtube.ts:1840`). | Make "fetch failed" the default for a missing or thrown result, per adapter and in the registry. Store resolved YouTube ids. Extend the existing test to every adapter. | M |
| L2 | The YouTube adapter keeps per-call state on a shared object | The list of failed fetches is cleared at the start of every call (`youtube.ts:1328`, `:1719`) and read after waits. Scout, the roster check and "Poll now" call the same object. | A Scout cycle that starts during an event poll erases the poll's failure list, and those channels are written as zeros. Return failures with each call's result. | S |
| L3 | The anomaly guard drops up to ten minutes of real movement, silently | `ccv-anomaly-detector.ts:54` allows 10 rejections in a row, tuned for a 30 second cadence while polling is 60. Rejected samples are skipped and logged at debug level only. | A real jump above five times (a raid, a show start) leaves a gap of up to ten minutes with no trace. Hold and release as the TikTok guard does, cap at 2 to 3 cycles, count rejections as an ops event. | M |
| L4 | The YouTube single-stream path can use another channel's video | The viewer count and title take the API's video before the ownership check (`youtube.ts:2017`), which only gates the view counter. | Ignore the API video unless its channel id matches, and treat "not started" or "ended" as not live. The data is already fetched. | S |
| L5 | Two live days in one series would double a channel | The poller writes one row per live day, and the rollup trigger sums rows that share a timestamp. **prod:** this has not happened in the last 120 days. | Take the maximum across days in the trigger, and warn on a second live day. | S to M |

### 6.2 Reliability

| # | Finding | Evidence | Fix | Effort |
|---|---------|----------|-----|--------|
| L6 | Unhandled rejections shut the process down | See U4. | Catch in the websocket handler, validate the message, limit messages per connection. Never exit on the counter: log and raise an ops event. | S |
| L7 | One slow platform delays every platform, and cycles overlap | The poller waits for all platforms with no deadline and inserts after the slowest (`adapters/index.ts:105`). No "already running" check (`polling-orchestrator.ts:257`). No timeout on the Twitch and YouTube API clients. SOOP's worst case per channel is about 94 seconds. | A per-platform deadline of about 40 seconds that marks the rest "fetch failed", inserts per platform as each completes, timeouts on every client, a running flag. | M |
| L8 | Nothing tells the operator that a platform or relay stopped | `/health` always answers ok (`server.ts:87`). "Polling stalled" fires only when a cycle wrote nothing at all. Relay statistics live in memory and never alert. "No backup written tonight" goes to a log file. | See O1: one source-health job, real `/health`, and new alerts. | M |
| L9 | The deploy path | See U13. Also: a push during a broadcast restarts the app, the minute in flight is lost because shutdown does not wait for the running cycle (`index.ts:445`), and the collector processes are never restarted by a deploy. | Stop on a migration error. Refuse to deploy while a day is live unless forced. Wait for the running cycle on shutdown. Restart the other processes when their files changed. | S |
| L10 | The Twitch relay can only overwrite | When the server fetch failed or the guard dropped the sample there is no row, and the browser value is thrown away (`relay.ts:315`). The scraper pushes only when something is live, so "alive, nothing live" looks the same as "dead". One shared secret for all machines. | Insert when no row exists. A heartbeat. A token per relay with a last-seen time. | M |
| L11 | YouTube key handling | The legacy key still stops on our own estimate and is shared by event polling, Discover and the views collector. Pool exhaustion sends no alert. An invalid key is retried first, again and again (`youtube.ts:545`). | Event polling on the pool with a reserved key, an alert on exhaustion, quarantine after repeated non-quota errors, a test call when a key is added. | M |
| L12 | One odd answer from Kick blanks Kick event polling for five minutes | The breaker trips on a single non-JSON response from any Kick endpoint, including Discover's (`kick.ts:224`). | Trip after several failures in a window, per endpoint family, with a probe before reopening. | S |
| L13 | Websocket authorisation and payload | A signed-in client can subscribe to any series. The welcome message sends every live day to everyone. The update message carries data the client ignores (`usePollingData.ts:70`). | Check the role on subscribe, filter the welcome, send only "series X changed at T". | S |
| L14 | Alerts depend on web push and on the database | Every alert reads its subscribers from the database (`push-notifier.ts:103`), so a database outage silences all of them. | A second channel that needs no database, such as a webhook to chat or mail. | M |

### 6.3 Missing for an operator

| # | Finding | Fix | Effort |
|---|---------|-----|--------|
| L15 | A day completes at its scheduled end even while its streams are live | Optional grace: keep polling while an official channel is live, extend in ten minute steps up to a cap, notify, let the operator trim afterwards. | M |
| L16 | No live coverage or gap view | Store failed and rejected samples sparsely. A strip per channel for the live day and a "no row in the last 5 minutes" list at the top of the editor. In the editor only: reports stay clean. | M to L |
| L17 | No gap repair workflow and no incident notes | After a day completes, list gaps per channel with actions: interpolate and mark as estimated, import a CSV, ignore. Show ops events and manual notes as markers on the editor timeline. | M to L |
| L18 | Rows do not say where they came from | A nullable source column: polled, relay, import, repair. It makes L16 and L17 auditable. | M |
| L19 | Structure and tests: `youtube.ts` (2,337 lines) holds quota accounting, three scrapers, the multi-stream path and Scout search. Retry code exists in seven adapters with different rules. No test covers the poller, the registry, the relay routes, the TikTok ingest or the websocket. | One shared HTTP helper with timeout, deadline-aware retry and breaker. An explicit live, offline or failed status on every adapter result. Poller tests with a fake registry. | L, in steps |

## 7. Explore and Ask

Keep as it is: Ask's closed list of intents (the model picks a tool and fills in real ids, it never writes SQL or numbers); the matcher that answers simple questions with no model call; answers that change the view with an Undo; the date handling in Discover's Ask.

### 7.1 Explore

| # | Finding | Evidence | Fix | Effort |
|---|---------|----------|-----|--------|
| E1 | Filters change the table only | The timeline is fetched without filters (`ExplorePage.tsx:280`). The footer prints a channel count and hours from the filtered rows beside a peak and average from the whole event (`:1680-1728`). Tier exclusion is declared and not implemented on the server (`viewership-snapshot.ts:38`). | "Russian watch parties" shows 14 channels next to the whole event's peak. Add tier, region and channel filters on the server and pass the view's filters to every endpoint. | M |
| E2 | A channel's average is not comparable between rostered and Scout-found channels | Same cause as R3: zero rows for offline rostered channels (`polling-orchestrator.ts:989`). | "Average while live" plus a live-minutes column. Hide rows that never went live. | S |
| E3 | A brushed range and the overlay survive a scope change | The scope handlers do not clear the range (`ExplorePage.tsx:662-698`). | Brush an hour on Day 1 and switch to Day 2: the strip shows Day 2's full-day numbers labelled as the selection. Clear the range and drop overlay channels that are not in the new scope. | S |
| E4 | Several URL writes in one click overwrite each other | Each write starts from the render-time copy of the address (`:261`). "Reset view" writes three times. The search box adds a history entry per keystroke. | One write per action. | S |
| E5 | Charts can crash on a long series and rebuild on every keystroke | `Math.max(...array)` over every point in several places (`charts.tsx:46`, `:499`, `InteractiveMainChart.tsx:233`). No downsampling. *unverified* as an actual crash. | A loop-based maximum, about two points per pixel, memoised paths. | M |
| E6 | The overlay downloads every channel's minute series to draw at most 8 lines | `ExplorePage.tsx:368`, from raw rows. For a long series that is roughly 600,000 rows of JSON. | A channel list parameter on a rollup query. | M |
| E7 | Compare events loads two full report payloads to use three numbers per day, and pairs days by position | Eight queries per day per series (`report-payload.ts:186`). Days are paired by index with no stage awareness, and a day without data shows 0 and "-100%" (`ExploreCompareEvents.tsx:84`). | One rollup query per series grouped by day. Align by stage, then day, with an "align from the last day" option. | M |
| E8 | In-page compare lines up "the n-th minute with data" | `ExplorePage.tsx:2738`. A tracking gap or an early pre-show shifts one curve against the other. | Minutes since each day's broadcast start. | S to M |
| E9 | Small numbers that disagree on one screen | Hours are rounded per channel before they are summed (`viewership.ts:408`). Three definitions of average are in use. Chart lines group by the language stored at poll time, tables by the channel's current language. | Round once in the UI, one average in one helper, grouped lines from the rollup (comes with X1). | S |
| E10 | Loading and error states read as "no data" | The pinned-minute rail shows "0 total CCV" while loading or after an error (`:1206`). Compare shows "Loading" forever after an error. | Use the shared loading and error blocks with a retry. | S |
| E11 | Not everything on screen is in the link | Chart dimension, line or stacked, table sort and saved views are not in the address. Saved views live in the browser only. Explore opens on the full series, the slowest view. | Add them to the address, store saved views per team, open on the live or latest day. | S to M |

### 7.2 Ask

| # | Finding | Evidence | Fix | Effort |
|---|---------|----------|-----|--------|
| A1 | Asking for a filter the series does not have clears the current filter and reports success | `matcher.ts:130`, `explore.ts:513`. "Show Russian channels" on a series with none removes the language filter. | Refuse with "No Russian channels in this series." | S |
| A2 | Parts of a request are dropped silently | Only the first tool call is used (`compiler.ts:164`). Only the top 150 channels are known, and the rest are reported as "not tracked" (`explore.ts:92`). | One tool call per answer by setting, or merge compatible ones. A server-side name search for channels outside the list. | S |
| A3 | The model call has no timeout and no cost record | No request timeout, so the default of ten minutes with retries applies. Token usage is never logged. Every API error is reported as "likely out of API credits" (`ask.ts:188`). The channel vocabulary is rebuilt for every question. | A 15 second timeout, usage and stop reason in the log, separate messages per error class, a 60 second vocabulary cache. | S to M |
| A4 | Two model ids, one of them old, and an upgrade that needs a code change first | See U14. The API reference says the newer models do not accept the forced tool choice this code uses. *unverified* against the live API. | One setting for the model. Switch to automatic tool choice with strict tools, then move to the current Sonnet. | M |
| A5 | Channel names from the platforms go into the prompt as plain text | `explore.ts:139`, `discover.ts:164`. A crafted name can steer which intent runs. It cannot produce SQL or numbers. | Send the vocabulary as a data block, strip control characters, keep the instruction in the system prompt. | S |
| A6 | Ask does not know today's date in Discover, and misplaces a time on a day that crosses midnight | `discover.ts:151`, `explore.ts:660`. | Add the date to the context. Pick the calendar date that falls inside the broadcast window. | S |
| A7 | Questions that fail today | Explore: one channel's numbers, "which day had the highest peak", platform or tier splits, a metric for a filtered subset, follow-ups. Discover: it can answer but cannot change the page. | Add the missing intents to Explore (Discover already has two of them). Let Discover's answers set the tab, range and platform. Pass the last answer as context for one follow-up. | M to L |
| A8 | Two implementations that drift, and no tests | Two near-identical route handlers and two copies of the answer card. Discover's card has Retry and re-ask chips, Explore's does not. Two Discover labels are wrong: "unique chatters" adds up per-session counts, and the breakdown's "Peak CCV" is the largest single stream. | One handler factory and one card. Table tests for both matchers and the refusal paths. A recorded set of 20 questions per surface. A log table of questions, so real failures can be read. | M |

### 7.3 Missing for an analyst

| # | Feature | Notes | Effort |
|---|---------|-------|--------|
| E12 | A day-by-day table at stage and series scope | Peak, average, hours, airtime and change against the previous day. Today this exists only inside compare events. | M |
| E13 | Segment numbers and curves | Official only, without watch parties, one language. Needs E1. A 100% stacked share view by platform and language. | M |
| E14 | Markers on the timeline | Stream title changes (already stored), manual notes, and tracking gaps. The gap data is already computed for day QA and Explore does not show it, so a tracker gap looks like an audience dip. | S for gaps, M for the rest |
| E15 | Export what is on screen | The chart as an image and the charted series as CSV. The export API already has the per-minute grains and Explore has no link to it. | S |
| E16 | A channel page for events | Per-day curve, share of the event, rank over time. Discover has a channel page and events do not. | M |
| E17 | Compare more than two events, aligned by stage | Finals against finals, with indexed curves. | M |

## 8. Discover

Discover's engine is sound. It reads whole categories down to a viewer floor on six platforms, turns minute rows into stream sessions with a title history, and scores each ended stream against a cohort with its evidence attached. What it lacks is everything around that engine: numbers that can be trusted in every view, the health signal on every platform, a way to know when a source died, settings that can be changed without SQL, and screens that answer more than "what is live right now".

Keep as it is: the category reads to a floor and the Kick per-language split; the YouTube gate with held viewership that is back-filled on approval; sessions closed and finalised in one transaction; the health score's design (cohorts by size and platform, evidence shown, no grade before three scored sessions, never a grade on a live stream); the stream page (viewer curve with chat bars and title markers); risers measured against each channel's own week; event windows shaded on the timeline; the rule that a failed platform read never drops channels.

### 8.1 What a first-time user can answer today

| Question | Today |
|----------|-------|
| How big is this game right now? | One click. |
| On which platforms? | Only on the list card, where the legend has no names. On the tracker page it takes one click per platform. |
| Who are the biggest channels? | One click live, three for a date range. |
| What is growing? | Two clicks, for channels only. Nothing at game level. |
| How does today compare with last week? | Not answerable. |
| Which channels look inorganic? | Not answerable without paging through a grade column. |
| What happened at that spike? | Three clicks, and the answer is for the minutes before the spike. |
| Is the data complete? | Not answerable. |

### 8.2 Data correctness

| # | Finding | Evidence | Fix | Effort |
|---|---------|----------|-----|--------|
| D1 | A minute with two poll cycles counts every channel twice | A cycle stamps its rows with the moment its fetches finish (`game-tracker-service.ts:378`), and fetches take 9 to 39 seconds on GTA VI. Two cycles can therefore land in one calendar minute while the minute before is empty. The bucket rollup and the raw timeline both total a minute as the SUM of its rows (`gt-bucket-rollup.ts` `per_minute`, `game-tracker-snapshot.ts:rangeAggregate`). Production: 7 doubled minutes on GTA VI in its first 5 hours, 2 to 3 a day on every other tracker. | Stamp every cycle with the minute it was scheduled for, and total a minute from one value per channel (the latest), which is how the per channel day stats and the session finals already work. | S |
| D2 | Stored peaks are wrong where D1 hit | `game_tracker_bucket_stats_v2.ccv_max` for GTA VI is 11,596,688 at 12:30 UTC against about 5.8 million in the minutes around it. The all-time peak rows for PUBG (328,764 against a bucket average of 186,248), GeoGuessr and Overwatch (1,144,674 against 332,262, at the minute of the September DNS outage) carry the same signature. PUBG: 2,641 of 28,317 buckets have a maximum above 1.5 times their average. | After D1, re-run the bucket rollup over every day that still has minute rows (all of PUBG, GeoGuessr and GOALS; the last 30 days of Apex and Overwatch). Older Apex and Overwatch buckets cannot be recomputed and need a stated rule. This must happen before any old minute rows are deleted. | S to run, after D1 |
| D3 | "Peak" means a different thing in each range | The Trends tab, the detail page and the list cards take the peak as the largest bucket average (`DiscoverTrendsTab.tsx:243`, `DiscoverDetailPage.tsx:748`, `DiscoverListPage.tsx:279`). So the 6 hour view shows the peak minute, the 24 hour view the peak 10 minute average, the 7 day view the peak 30 minute average and the 30 day view the peak hourly average. The rollup already stores the true per bucket maximum and the range endpoint does not return it. | Return `peak` per bucket from `/snapshots/range` and use it for every peak figure. One definition: the highest single minute. | S |
| D4 | The breakdown's raw tail reports a different kind of peak | `game-tracker-rollup-reads.ts:437` takes `MAX(concurrent_viewers)` over raw rows, which is the largest single channel, and merges it with bucket maxima that are platform totals. | Compute the tail the same way as the buckets. | S |
| D5 | Hours watched are overstated in buckets with a missing minute | `DiscoverTrendsTab.tsx:254` multiplies each bucket average by the full bucket length. The rollup stores how many minutes had data and the endpoint drops it. | Return `minutes` and `ccv_sum` per bucket and sum those. | S |
| D6 | Days are UTC days | Per channel day stats and the "7 days or more" snapping use UTC midnights (`gt-ranges.ts:164`). A user in Stockholm sees "today" start at 01:00 or 02:00 local. | Keep the storage, say "UTC" in the range label, or store hourly per channel stats so any local day can be built. | S for the label, L for hourly stats |

### 8.3 Coverage

| # | Finding | Evidence | Fix | Effort |
|---|---------|----------|-----|--------|
| C1 | Kick chat is dead (see U2) | Zero rows since 2026-10-17. | Find why Kick drops the socket (changed key, cluster or subscribe limit), fix, and add the alert in O1 so it cannot go unnoticed again. | S to M |
| C2 | No chat signal on SOOP, CHZZK or TikTok | The collector handles Twitch, Kick and YouTube only (`scripts/chat-collector.ts`). | A spike per platform to confirm a public chat socket exists, then add it as a collector source. SOOP first, because it is PUBG's largest platform. | M each |
| C3 | Follower readings stop at the top 150 channels per tracker | `FOLLOWER_TOP_N = 150` (`game-tracker-service.ts:778`). GTA VI: 116 of 1,904 live channels have a recent reading. | Scale the limit with the tracker's size and spread the reads across cycles, within each platform's rate limit. | S |
| C4 | YouTube depth is one API key | 150 streams on GTA VI is the ceiling of one key at one read a minute. | More Google projects (only you can create them), or read the long tail every 5 minutes and the top every minute. | S once keys exist |
| C5 | TikTok is a regional sample captured from a laptop | See U12. | A small always-on machine on a home connection, or a residential proxy on the server, running the same script under a process manager. | M |
| C6 | Kick English streams between 50 and 70 viewers can be missed | The per language list returns 100 rows and English fills it. | Accept and state it in the coverage panel (N1), or add a second sort order if Kick's API offers one. | S |
| C7 | The YouTube review queue is not being worked (see U11) | 488 pending on PUBG. | Bulk actions, an "approve all whose title matches" rule, auto-expiry of pending rows that have not been seen for 14 days, and a count on the tracker card. | M |

### 8.4 Backend code and structure

| # | Finding | Evidence | Fix | Effort |
|---|---------|----------|-----|--------|
| B1 | A cycle can overlap itself (see U9) | `setInterval` at `game-tracker-service.ts:136`, no in-flight flag. | Skip a tick while the previous cycle runs, and log the skip as an ops event. | S |
| B2 | One UPDATE per channel per cycle | `recordMatch`, `bumpMismatch`, `softDrop` and `upsert` run row by row inside the loop (`game-tracker-channel.ts:43-95`). About 1,650 round trips a cycle on GTA VI. The same table's index is bloated to 233 MB over a 29 MB table from these updates. | Three set-based statements per cycle: mark matched, bump unmatched, drop those over the threshold. | S |
| B3 | `runCycle` is one 420 line method with six platform branches inline | `game-tracker-service.ts:169-590`. Adding CHZZK meant editing the service, the route validation, a metadata helper and the frontend's platform lists. | A small "category source" interface (`id`, `isConfigured(tracker)`, `list(tracker)`), one file per platform, registered in a list. The service loops over the list. | M |
| B4 | Tracker settings live in three shapes | Twitch, Kick, SOOP and TikTok have columns. CHZZK, the Kick language split and extra TikTok categories live in `metadata`. YouTube lives in `youtube_config`. | One typed `platforms` object per tracker, validated on write, with the old columns kept as a read fallback during the move. | M |
| B5 | Create and update write the request body straight to the table | `GameTrackerModel.update(existing.id, req.body)` (`game-trackers.ts:121`, `game-tracker.ts:101`). No field list, no type checks. Admin only, but a typo in a field name is a 500 and a wrong type is stored. | A field whitelist and a schema check shared with B4. | S |
| B6 | A changed polling interval does nothing until a restart | `startTracker` returns early when a timer exists (`game-tracker-service.ts:119`). | Re-arm the timer when the interval changes. | S |
| B7 | Deleting a tracker deletes its history in one statement | `ON DELETE CASCADE` from `game_trackers` to snapshots, sessions and stats. On PUBG that is 75 million rows inside the 40 second statement timeout: the request fails, and if it did not, months of data would be gone on one click. | Replace delete with archive (status `archived`, hidden, polling stopped). A real purge becomes a script run by hand. | S |
| B8 | The tracker list endpoint returns the YouTube gating vocabulary to every role | `GET /api/game-trackers` returns raw rows (`game-trackers.ts:40`), while `GET /:slug` strips `youtube_config` for viewers. | Strip it in the list as well. | S |
| B9 | SQL and business rules sit in the route file | `game-trackers.ts` is 1,130 lines; the trending query, the recent-channels query and the health gate live in handlers. | Move reads into the models, keep handlers to parsing and shaping. Do it when touching each endpoint, not as a big-bang rewrite. | M |
| B10 | Tracker channels share the `channels` table with events through a stub series | 178,298 of 181,418 rows in `channels` belong to trackers. `channels.series_id` is NOT NULL, so each tracker owns a hidden series (`ensureBoundSeries`). The canonical-row rule that binds one identifier to one row is there to paper over this. | Longer term: a `streamers` table (platform, identifier, name, avatar) that both event channels and tracker channels point to. It also gives the cross-game and event-to-Discover links in N9 and N10. Not urgent, and the largest structural change on this list. | L |
| B11 | Processes outside the main app are never restarted by a deploy | `deploy/update.sh:59` restarts `clutch-viewership` only. `chat-collector`, `kick-chatroom-resolver` and `vod-chat-backfill` keep running old code. | Restart them in the deploy when their files changed. | S |
| B12 | A failed migration is reported as "no pending migrations" | `deploy/update.sh:56` silences the migration command's errors and prints "no pending migrations" whenever it fails. The restart follows regardless. | Stop the deploy on a migration error. | S |

### 8.5 Storage

Where the 118 GB is: database 53 GB (`game_tracker_snapshots` 37 GB, `chat_minute_rollup` 7.3 GB, event snapshots 2.7 GB), five local backups 55 GB, the rest system and logs.

| # | Finding | Evidence | Fix | Effort |
|---|---------|----------|-----|--------|
| S1 | Backups cost more disk than the database | 5 copies of 11 GB on the same disk as the data they protect. | Send backups to object storage and keep one local copy. Until then, leave the Discover minute rows out of the nightly dump (the buckets, day stats and sessions stay in). Either one frees about 40 GB. | S |
| S2 | A 4.3 GB index that nothing has ever read | `game_tracker_snapshots_pkey` (a random id per row): 0 scans since the database was created. Two more on the day stats table: 624 MB, 0 scans. | Drop them, by hand, at a quiet hour, with a short lock timeout. Frees about 5 GB and makes every insert cheaper. | S |
| S3 | Every minute row repeats the stream title and game name | Average row 206 bytes, of which the title is 59 and the game name 18. Sessions already keep the full title history. | Stop writing both to minute rows once the screens that read a title from a snapshot read it from the session. About a third less growth. | M |
| S4 | Retention deletes row by row from one huge table | `raw-retention.ts` deletes in 50,000 row batches. 9.7 million dead rows wait for a vacuum that last ran on 2026-11-05. | Partition `game_tracker_snapshots` by day. Retention becomes dropping a partition: instant, no bloat. Needs disk headroom to migrate, so it follows S1. | M |
| S5 | Three trackers keep minute rows forever | `retain_raw_days` is empty on PUBG, GeoGuessr and GOALS. **prod:** PUBG alone holds 75 million of the 97 million rows, back to May, about 28 GB with indexes. | Your call. If the partner use case needs minute curves per stream, keep them and pay for the disk. If 10 minute curves for the game and day stats per channel are enough after 90 days, set 90. | Decision |
| S6 | Nobody is told when the disk fills | No alert exists. | Part of O1. | S |

### 8.6 Screens: bugs

| # | Finding | Evidence | Fix | Effort |
|---|---------|----------|-----|--------|
| G1 | "New today" can never exceed 50 | The page asks for 200 and counts the rows (`DiscoverDetailPage.tsx:766`). The server caps the list at 50 (`game-trackers.ts:1090`). It is also a rolling 24 hours and ignores the platform filter beside it. | Return a count from the server. Label it "New in 24h". | S |
| G2 | The "By platform" chart joins its series by position, not by time | `DiscoverTrendsTab.tsx:425`. The API leaves out buckets with no rows, so a platform with a gap is drawn shifted in time and the stack total is wrong. Six platforms are hard-coded, so six requests fire for every tracker, and TikTok and CHZZK share one grey. | Join on the timestamp and fill gaps with zero. Ask only for platforms that have data. Take colours from the shared platform list. | S to M |
| G3 | Trending lists filter by platform after cutting to the top 20 | `DiscoverTrendsTab.tsx:519`. On a platform filter the page can say that no channel beat its baseline when some did. The Live rail asks for 5 rows, drops the new ones and often shows nothing. Its rows are not links. | A platform parameter on the trending endpoint. | S |
| G4 | Clicking a point on the chart answers for the wrong moment | The click sends the bucket's start (`DiscoverTimelineChart.tsx:101`) and the leaderboard reads the two minutes before it. It ignores the platform filter and shows 25 rows with no total. On the 7 and 30 day views a bucket is 30 or 60 minutes wide. | Use the bucket's peak minute (needs D3), pass the platform, show "25 of N". | M |
| G5 | A live stream's page shows average 0, hours 0 and duration 0 s | Those three fields are filled only when the stream ends (`DiscoverStreamPage.tsx:246`). The channel page already works around this. | Compute them from the loaded timeline while live. | S |
| G6 | One failed 30 second refresh blanks the whole tracker page | Any error replaces the page with an error block (`DiscoverDetailPage.tsx:223`). All tabs unmount, so ticked review rows, filters and scroll position are lost. | Keep the last good data and show a small retry mark. | S |
| G7 | "The game has no viewers" and "the collector is down" look the same | The "Live" pill shows the tracker's setting. The freshness label measures the browser's own fetch (`:1014`). The list page loads once and never refreshes. | Return the last data time per platform and show a stale mark. Refresh the list every minute. | S to M |
| G8 | Two different "live channels" numbers on one page | The hero prints the roster size as "channels live" (`:273`). The KPI under it uses the live total. | One source for every live count. | S |
| G9 | Search counts and sorts a capped list | Results are the 100 most recent matches, shown as "N matches" and sorted by peak within those 100 (`DiscoverSearchResults.tsx:51`). The search box disappears in search mode. "Clear" drops the tab and filters. An older response can overwrite a newer one (`DiscoverSearch.tsx:70`). | Total and sort on the server. Keep the box visible. Cancel stale requests. | S to M |
| G10 | Sorting by language renumbers ranks, and every CSV is a truncated list | The sort reorders one page of 50 (`DiscoverChannelsTab.tsx:201`). Exports hold 50, 200 or 25 rows with nothing in the file saying so. | Sort on the server. A server-side "export all". | M |
| G11 | Charts leave out empty time | The x axis is a list of buckets that have rows (`DiscoverChannelPage.tsx:550`, `DiscoverTimelineChart.tsx:265`). On a channel's 7 day chart separate streams are joined by a line. On the tracker chart an outage disappears. | A real time axis with gaps, and session bands on the channel chart. | S to M |
| G12 | YouTube review: the rules editor eats spaces, and the queue reorders under the reviewer | List fields are split and trimmed on every keystroke (`DiscoverYouTubeGating.tsx:287`), so a phrase can only be pasted. The queue reloads on every 30 second page refresh. YouTube cannot be switched on for a tracker from the UI. | Keep the typed text and split on save. Stop the reload. Add the switch and the fields the API already accepts. | S to M |
| G13 | The admin form | It covers name, slug, three category pickers, TikTok and the viewer floor. In edit mode the slug follows the name (`DiscoverAdminNew.tsx:86`), so a rename changes the address and breaks old links. It refuses a tracker whose only sources are YouTube or CHZZK. Database only today: CHZZK, the Kick language split, extra TikTok categories, YouTube on or off, the channel cap, retention and both intervals. | See N15. | M |
| G14 | Wasted requests | The list fetches 60 leaderboard rows per tracker to show 3. The tracker's settings are refetched every 30 seconds. Two endpoints compute joins the page throws away (`game-trackers.ts:718`, `:856`). Event-side polls keep running on Discover pages. | Trim each. | S to M |

### 8.7 Screens: design and structure

| # | Finding | Evidence | Fix | Effort |
|---|---------|----------|-----|--------|
| G15 | The view is copied into the address instead of read from it | Tabs read the address once and then write back (`DiscoverChannelsTab.tsx:50`, `DiscoverTrendsTab.tsx:83`). Ask's "open in Channels" link is ignored when already on that tab. A custom range is lost after a visit to Trends. Back never returns to the previous tab. "Copy link" leaves out sort, chart mode and the trending window. | One hook that makes the address the single source, as Explore does. | M |
| G16 | The platform split is missing on the tracker page and unlabelled on the card | The data is already loaded. Labels come out as "Tiktok" and "Youtube". Page copy lists the platforms without CHZZK. | A per-platform block on the first tab: name, viewers, channels, share. A click sets the filter. | S |
| G17 | Discover breaks the numbers-only rule | About 15 inline explanatory notes across the tabs, the channel page and the stream page. The shared question-mark popover has no caller in Discover. | Move each behind one popover per section, or into the coverage panel (N1). | S |
| G18 | Controls rebuilt instead of reused | Three sort-header versions, two grade chips with different colours for B on the same page, three platform colour maps, four chart set-ups, about 20 hand-written fetch effects. Trends has two time controls with different words. | Use the shared pieces. One chart component for Discover with total, platform and language modes. | M |
| G19 | Keyboard and phone | Three tab stops per table row, so 600 on the live table. Chart selection is pointer only. The card legend is colour only. | Fix with G18. | S to M |
| G20 | File structure | The tracker page and its tabs import from each other in a circle. Dead components remain in four files. No test mentions Discover. | A shell of about 350 lines, one file per tab, shared pieces in `components/discover`, two hooks (address state and live data). | M |

The backend already serves data that no screen shows: channels live over time, per-language history, the range average per channel, a channel's chat and follower change over a range, its peak percentile, found against tracked per cycle, a paged leaderboard at any past minute, and an endpoint to remove a wrong channel from a tracker. Several features below are therefore mostly screen work.

### 8.8 Missing features

| # | Feature | What it gives | What already exists | Effort |
|---|---------|---------------|---------------------|--------|
| N1 | Coverage panel per tracker | One popover that states, per platform: the source, the viewer floor, whether the channel cap was hit, sampled or limited by quota, the time of the last data, how many channels have chat, how long minute rows are kept. | Found against tracked per cycle is served. The failed-platform set needs exposing. | M |
| N2 | Any date range, and a comparison period | Custom dates on Trends, a "previous period" overlay, change chips on the KPIs: now against the same time yesterday, this week against last. | The range endpoint takes any dates. | M |
| N3 | More chart dimensions | Language share over time, channels live over time, a 100% share mode. | Per-language buckets and channel counts are stored and not served. | M |
| N4 | Game against game | A compare page that overlays trackers, a sortable list, a game switcher that keeps the current tab, platform and range. | The range series per tracker. | M to L |
| N5 | Top streams, records and events | The biggest streams of a day, week or range by peak or hours. A records block: all-time peak, best day, best stream. A list of official events that links to Explore. | Sessions hold every stream. Event windows are served for shading. | M |
| N6 | A health view | Sort and filter channels by grade, flags and chatters per viewer. At game level: the share of viewers on channels by grade, behind the same evidence gate. | Grades, flags and the per-channel chat ratio are computed. | M to L |
| N7 | A deeper channel page | 90 days and a year from day stats, a pager on sessions, an average column, event shading, and the chat and follower figures that are already fetched and not shown. | All of it is stored. | M |
| N8 | Export | A server-side CSV of the whole leaderboard or timeline, and the chart as an image. | The event side has an export dialog to borrow from. | M |
| N9 | One streamer across games and events | "Also streams" on a channel page, audience overlap between games, a link from an event channel to its Discover history. For a launch like GTA VI: which games the streamers came from. | Needs the streamer table in B10. | L |
| N10 | The effect of an event on its game | Per official event window: the game's baseline against the event, and the share of game viewers on official and watch-party channels. | Event windows and both data sets. | M |
| N11 | Alerts | A game passes a threshold, a new all-time peak, a channel spikes, a source goes quiet. | Push notifications exist for events. | M |
| N12 | Saved views | Named views per team, after G15. | Explore has a browser-only version. | S to M |
| N13 | Title segments | Saved keyword filters with their share over time. For GTA VI: role-play, story, online. | Session title history. | M to L |
| N14 | A Discover report and a public game page | A weekly or monthly report per game in the existing report design, and a public page like the event one. | The report page and its cards. | L |
| N15 | A complete settings form | One section per platform with every option, validation, and archive in place of delete. | See G13, B4, B5, B7. | M |

### 8.9 Proposed shape of the tracker page

- **Overview** in place of Live: a KPI row with change chips, the platform block (G16), top live channels, rising now, new faces.
- **Trends**: one chart with dimension and metric switches (N3), any range and a comparison period (N2), the breakdown, the hour-of-day strip.
- **Channels**: the range leaderboard with server-side sort, average and health columns, and export.
- **Streams**, new: top streams and records (N5).
- **Health**, new: N6.
- **Review**, editors only.
- In the header: the game switcher (N4), Coverage (N1), Settings (N15), Copy link.
- One range control and one platform filter for the whole page, both in the address (G15).

## 9. Across the whole product

| # | Finding | Evidence | Fix | Effort |
|---|---------|----------|-----|--------|
| O1 | Nothing watches the data sources | Kick chat was dead for a month (U2). The disk filled once in September and is filling again (U3). The app logs no request and no request time, nginx logs no request time, and Postgres has no query statistics extension. `ops_events` and the push notifier exist and are used for event alerts only. | One "source health" job, every 5 minutes: per tracker and platform, rows in the last 10 minutes against the same hour yesterday; chat rows per platform; last TikTok capture per category; YouTube quota left; disk free; last backup written; Discover cycle time and skips. Each check writes an ops event and sends a push on change of state. A status page in Settings shows the same table. | M |
| O2 | The dashboard's source is not on the main branch | `main` tracks no file under `src/dashboard`. The source lives on `redesign/claude-design`, which split from `main` on 2026-04-16 and is 190 commits ahead on its side, 232 on the other. The live dashboard is built on the work Mac and copied to the server by hand. Until today 41 of those commits existed only on that Mac. | Bring `src/dashboard` onto `main` (the backend files on the redesign branch are stale and are dropped), build the dashboard in the deploy, and retire the hand copy. One branch, one deploy, and a dashboard change can ship together with the API change it needs. | M |
| O3 | A deploy runs no check | `.github/workflows/deploy.yml` only deploys. The backend has 35 unit test files that pass locally. The frontend has none. There is no linter. | Run the type check, the backend tests and a dashboard build before the deploy step, and stop on failure. Add tests for the frontend's number formatting and aggregation helpers, which is where the "total of a capped list" class of bug lives. | S to M |
| O4 | Backups sit on the disk they protect | `deploy/daily-backup.sh` writes to the app folder. | See S1: object storage, plus a restore test once a quarter. | S |
| O5 | One process does everything | Event polling, Discover polling, rollups, the API and the websocket share one Node process and one 10 connection database pool. | Not urgent at today's load. The first split worth making is moving Discover polling and its rollups into their own process so a heavy tracker can never delay an event poll. | M |
| O6 | Very large files | `ExplorePage.tsx` 3,327 lines, `ReportPage.tsx` 2,352, `EditorDesktop.tsx` 2,285, `youtube.ts` 2,337, `api.ts` 1,983. | Split when a file is next changed for a feature, along the seams named in each area above. No rewrite for its own sake. | ongoing |

## 10. Roadmap

The order follows one rule: first make the numbers right and the system safe, then make failures visible, then build.

### Phase 0: correct numbers and closed holes (about one week)

Every item changes production and needs a go. Suggested order:

1. **Discover minutes.** D1, B1 and B2 together, then the repair in D2. This comes before any deletion of minute rows, because the repair needs them.
2. **Kick chat.** C1.
3. **Disk.** S1 and S2, and the decision in S5.
4. **The public surface.** U4 (websocket), U5 with R4 and L13 (ids tied to the series, a minimal public websocket message), R12 (rate limit).
5. **Editor data loss.** V1 and V2. PGSC4 is exposed to V2 today.
6. **Slow pages.** X1, X2, X3 and V3.
7. **Deploy.** U13 and L9.
8. **YouTube adapter.** L2 and L4.

### Phase 1: know when something breaks (one to two weeks)

- O1: the source-health job, its alerts, the status page and a real `/health`. L14: a second alert channel.
- L1 (no zeros on a failed fetch), L7 (deadlines, running flag, timeouts), L3 (anomaly guard), L12 (Kick breaker), X4 (separate pool).
- O2 and O3: the dashboard on `main`, one deploy, checks before it.
- S4 (partitioning) and S3 (slimmer rows).
- D3, D4 and D5: one definition of peak, and hours watched from stored minutes.

### Phase 2: Discover as a product (three to five weeks)

- **Trust the screens.** G1 to G11, G14, the coverage panel N1, the numbers-only clean-up G17.
- **Foundations.** G15 (address state), G18 and G20 (shared pieces, file split), B3 to B5 (platform sources, typed settings), N15 (settings form), B7 (archive), G12 and C7 (review queue).
- **Analysis.** The Overview tab with G16, then N2, N3, N5, N7, N6, N8, N4.
- **Coverage, in parallel.** C2 (SOOP chat first), C3, C4, C5.
- **After that.** N11, N12, N10, N13, then N9 with B10, then N14.

### Phase 3: events, reports and live (three to four weeks, can interleave with Phase 2)

- **Reports.** R1 with R6 and R17 (published reports with a share id and a history), R14 (share action), R15 (print and PDF), R2 (one answer for splits), R3 (averages, after a before-and-after comparison), R7 and R8 (exports), R10 (labels), R11 (retire the legacy path), R16.
- **Events.** V5 (one save), V6, V7, V4, V9, V10, V8, then V11 and V12 (Scout state and blocklist), V17 to V20 (review at scale, bulk add, channel list, clone and schedule tools), V14 to V16 (permissions), V21.
- **Live.** L10 (relay), L11 (keys), L15 (grace at day end), L18 (source column), L16 and L17 (coverage view and gap repair).
- **Explore and Ask.** E1, E3, E4, E5, E6, E7, E8, then A1 to A6 and A8, then A7 and E12 to E17.

### Ongoing: structure

Split a large file when it is next changed, along the seams named in each section. Delete the dead code in R19. Introduce the shared HTTP helper in L19 adapter by adapter. Add a test wherever this review found a bug.

## 11. Decisions needed

1. **Disk, this week.** Four levers: leave Discover minute rows out of the nightly dump (frees about 40 GB as the old copies rotate out, and the buckets, day stats and sessions stay in the dump); drop three indexes that nothing reads (about 5 GB); move backups to object storage (needs a storage bucket and key created in the hosting account); a retention period for the three trackers that keep minute rows forever. Recommendation: the first two now, object storage next, retention only after the repair in D2.
2. **Minute rows for PUBG, GeoGuessr and GOALS.** Keep forever, or keep 90 days once the buckets are repaired.
3. **Phase 0.** A go for the whole list or item by item. No event broadcast is scheduled in the 24 hours after this was written.
4. **Old Apex and Overwatch buckets.** Their minute rows are gone, so doubled maxima cannot be recomputed. Proposal: where a bucket's stored maximum is more than 1.5 times its own average, replace it with the higher of its two neighbours' maxima.
5. **Report averages.** Unifying the definition (R3) moves published averages a little. Compare on three past events first, then decide.
6. **Legacy outputs.** Retire the static HTML report and the PDF, Word and Excel pipeline once published reports and a print stylesheet exist.
7. **YouTube API keys.** Two or three more Google projects raise GTA VI's YouTube depth and separate event polling from Discover. Only the account owner can create them.
8. **TikTok capture.** Where it should live: the Relay MacBook once it is back, a small always-on machine, or a paid residential proxy on the server.
9. **Automatic extension of a day** while official channels are still live (L15): wanted or not.
10. **Order.** Discover (Phase 2) before events and reports (Phase 3), or interleaved.

## 12. Not checked

- The screens were not viewed in a browser. With a sign-in in the browser pane a visual pass can follow.
- Items marked *unverified*.
- No load test, and no query plans beyond the timing in U8.
- Whether the health score's thresholds are statistically right. Only its reach and its plumbing were reviewed.
