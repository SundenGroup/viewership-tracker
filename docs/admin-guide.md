# Clutch Viewership Tracker — Admin Guide

Operating the tracker: architecture, configuration, the YouTube review queue,
data imports, deploys and troubleshooting.

For reading the numbers rather than running the system, see the
[User Guide](user-guide.md). For who-can-do-what, see [permissions.md](permissions.md).

---

## 1. What runs where

**Production server** — `165.232.126.195`, serving `tracker.clutch.game`.

Three long-lived processes under pm2:

| Process | What it is |
|---|---|
| `clutch-viewership` | The API, the poller, the WebSocket server (`dist/index.js`) |
| `chat-collector` | Twitch IRC + Kick Pusher + YouTube InnerTube chat ingestion |
| `kick-chatroom-resolver` | Resolves Kick chatroom ids (Python, loops) |

```bash
ssh root@165.232.126.195 "pm2 status"
```

**Off-server collectors.** The Twitch browser scraper runs on a residential
PC, not the datacenter, because Twitch's numbers differ by origin. Same for
the Kick chatroom-id relay. See [setup-relay-pc.md](setup-relay-pc.md).

**Two git repos, one worktree.**

- Backend: `clutch-viewership-tracker` on `main`
- Dashboard: `clutch-viewership-tracker-redesign` on `redesign/claude-design`
  — a linked worktree of the same repository

This trips people up constantly: **`deploy/update.sh` is backend-only.** The
dashboard is a separate build-and-rsync.

---

## 2. Deploying

### Backend

```bash
ssh root@165.232.126.195 "cd /opt/clutch-viewership-tracker && bash deploy/update.sh"
```

Takes a pre-deploy `pg_dump`, pulls, builds, migrates, restarts pm2.

### Dashboard

```bash
cd /Users/silverfox/clutch-viewership-tracker-redesign/src/dashboard && npm run build && rsync -a --delete dist/ root@165.232.126.195:/opt/clutch-viewership-tracker/src/dashboard/dist/
```

### Migrations and the backup collision

`deploy/update.sh` takes a `pg_dump` first, and **pg_dump holds a snapshot on
every table**. A schema migration run at the same time can't acquire its lock,
and — this is the dangerous part — while it waits, every write queued behind it
stalls too. A migration that merely *can't run yet* will take data collection
down with it.

Migrations that alter tables must set a lock timeout so they fail fast:

```ts
await knex.raw("SET LOCAL lock_timeout = '5s'");
```

Before running migrations manually, check nothing is dumping:

```bash
ssh root@165.232.126.195 "pgrep -x pg_dump && echo BUSY || echo clear"
```

---

## 3. Explore: series and channels

### Lifecycle

Create a **series**, add **broadcast days** with start/end times, add
**stages** within days, then attach **channels**.

Broadcast days transition automatically: `scheduled → live → completed` once
`broadcast_end` passes.

**To reopen a completed day** you must do *two* things — set `status = live`
**and** push `broadcast_end` into the future. Change only the status and the
orchestrator will re-complete it on the next cycle.

Series status is manual and organisational only; nothing auto-completes it,
and `active` covers upcoming events as well as running ones.

### Channel day tags

A channel with no day rows is tracked on **all days**. Day-pinning restricts
it to specific days.

**Never bulk-modify day tags.** Manually-added channels are meant to be
all-days, and a bulk edit silently pins them.

Watch-party rosters are the exception: pin them to confirmed days *and* keep
them active, because keyword-gated discovery can't guarantee it will re-find
them.

### CSV import

Official platform exports replace scraped estimates. The importer
auto-detects Twitch vs YouTube format, and handles both wall-clock timestamps
and relative offsets (`Live stream position (seconds)`), resolving the anchor
from the video's `actualStartTime`.

Use this whenever a platform gives you real data — it is always better than
what we collected.

---

## 4. Discover: game trackers

### Creating one

A tracker needs a name, a slug, and the platform category ids for Twitch and
Kick. YouTube is opt-in per tracker (`youtube_enabled`).

Key dials:

| Setting | What it controls |
|---|---|
| `polling_interval_seconds` | How often live streams are re-polled |
| `discovery_interval_seconds` | How often we look for new streams (Twitch/Kick) |
| `min_ccv_threshold` | Floor below which streams are ignored |
| `max_active_channels` | Ceiling on tracked streams |
| `retain_raw_days` | Raw snapshot retention. **NULL = keep forever** |

### YouTube: why it needs a human

Twitch and Kick hand us an authoritative category listing. YouTube does not,
and this is the single most important thing to understand about the system:

**YouTube has no per-stream game association.** `topicDetails` returns
identical generic topics for PUBG PC and BGMI. `categoryId` is 20 for every
gaming stream. The game card was retired with YouTube Gaming in 2019. There is
no field to read.

So membership is a recorded human judgment, held per `(tracker, channel)` —
strictly per-game. The same streamer can be approved for PUBG and denied for
GeoGuessr independently.

There are also no "list everything live in category 20" APIs. This was tested
directly: `search.list` with `eventType=live` and no query returns zero items;
adding `videoCategoryId=20` also returns zero. A query term is mandatory.
Coverage therefore comes from **many targeted searches × deep pagination × an
accumulating channel index**, never enumeration.

### Working the review queue

Discover → Channels → YouTube filter (admin only). Three actions:

| Action | Effect |
|---|---|
| **Track matching** | Count only streams whose **title** matches this game's vocabulary. Use for variety streamers. |
| **Track all** | Count everything they stream in category 20. Use for an org or tournament channel. |
| **Exclude** | Never count this channel for this tracker. |

Every stream from an approved channel is re-tested each cycle:

```
1. category 20 (Gaming)?            no  → dropped
2. Exclude word in the title?       yes → dropped
3. Include word in the title?       no  → dropped   (Track matching only)
```

Test 3 reads the **title only**. Tags describe the channel's brand — a
PUBG-known streamer carries "pubg" tags through their Valorant nights — so
tags can corroborate an unknown channel's identity but never say what's on
screen right now.

**Pending channels are not counted — but nothing is lost.** Silence beats a
wrong number, so a pending channel never appears in charts or reports. Its
viewership is **banked** instead: every poll writes the would-be snapshot to a
quarantine table no read path touches. The queue row shows how much is held
("3h 12m of viewership banked"). Then:

- **Approve** → the held rows are copied into the real data with their
  original timestamps, so the channel's history starts when it first
  appeared, not when you got around to it. Under *Track matching*, only
  held streams whose title matches the vocabulary are backfilled — the
  rest are discarded, exactly as live tracking would have treated them.
- **Exclude** → the hold is discarded.
- **Nobody decides** → the hold expires after 14 days.

So the queue can be worked at leisure — review latency costs no data. The
one thing backfill cannot recover is a hold that already expired, so aim to
clear the queue within two weeks.

Your decisions are permanent. Automatic decisions are provisional and get
re-checked once a stream crosses `alwaysReviewAboveCcv` — a channel
auto-approved at 300 viewers must not stay unexamined at 3,000.

### The matching vocabulary

**Edit rules** in the same panel:

| Field | Role |
|---|---|
| `include` | Names and abbreviations — the main matching list |
| `strongPhrases` | Distinctive enough to auto-approve an unknown channel |
| `strongTags` | Exact creator tags — corroborate identity only |
| `exclude` | In a title → dropped, even from a Track-all channel |
| `queries` | What we search YouTube Live for (zero quota) |

Deliberately built from *positive* evidence. The alternative — "drop it if the
title names a different game" — needs an enumeration of every game that
exists, which is unbounded and stale on every new release.

**When a new tournament starts, add its abbreviation to `include`.** That is
the single highest-value maintenance action, because a Track-matching channel
streaming an event they don't name will otherwise go uncounted.

Titles are normalised before matching, so `𝗣𝗠𝗡𝗖`, `ᴘᴜʙɢ` and `🅿🆄🅱🅶` all fold
to plain ASCII.

For a game with a generic name (GOALS), set `autoAllowWeakBelowCcv: 0` so only
strong matches flow through automatically.

### YouTube quota

`videos.list` bills **1 unit per call**, not per id, and takes up to 50 ids —
so ~40 streams polled every 60s costs about 1,440 units/day against a 10,000
quota. Discovery is a page scrape and costs nothing. Chat uses InnerTube and
costs nothing; the official chat API would cost ~17,000 units/day *per stream*.

---

## 5. Data integrity

### Health scoring

Every stream session is scored 0–100 and graded A–F. `A ≥85, B ≥70, C ≥55,
D ≥40, F <40`. Gates apply to the **score**, so the letter is always a pure
function of the number.

D and F require actual red flags — percentile rank alone can only sink a
stream to the bottom of C. This is what keeps the grade meaningful: an F says
"look at this", not "this is unpopular".

### Known data hazards

**YouTube `/live` redirects.** `youtube.com/channel/X/live` can redirect to a
*different* channel's stream. Scrapes must verify ownership or drop the
result. This has caused real misattribution — a small channel credited with a
tournament's entire audience. Attribution is now by explicit video id.

**Twitch scraper tab bleed.** The browser scraper occasionally writes the same
CCV across sibling tabs in a single poll. The symptom is identical
`concurrent_viewers` across several channels at one timestamp.

**Never infer a YouTube stream's language from page chrome.** UI strings in the
HTML are the *viewer's* locale, not the broadcast's.

**Store YouTube channels as `UC…` ids, never `@handles`.** A handle/UC mismatch
creates duplicate channel rows and double-counts. The API path resolves this
already; raw SQL imports must do it manually.

### Freshness ≠ health

Recent rows in the database do **not** prove a relay is working. Confirm the
source is actually pushing:

```bash
ssh root@165.232.126.195 "pm2 logs clutch-viewership --lines 200 --nostream | grep '\[Relay\]'"
```

---

## 6. Troubleshooting

**Discover numbers dropped suddenly.**
Check the YouTube review queue first, then `include`/`exclude`. A new event
abbreviation missing from the vocabulary silently drops every Track-matching
channel covering it.

**The review queue stopped filling.**
The gating upsert must dedupe by channel before insert. A channel running
simultaneous streams (esports main + map view) puts the same conflict key in
one INSERT twice, and Postgres fails the *entire* batch with `ON CONFLICT DO
UPDATE command cannot affect row a second time`. Live decisions keep working
while the queue silently freezes.

**A migration is hanging.**
It's queued behind `pg_dump`. Cancel it — while it waits it blocks writes:

```bash
ssh root@165.232.126.195 "sudo -u postgres psql -d clutch_viewership -c \"SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE query LIKE 'alter table%' AND wait_event_type='Lock'\""
```

**A completed day won't stay reopened.**
You changed status without pushing `broadcast_end`. See §3.

**Dashboard changes aren't showing.**
`deploy/update.sh` doesn't touch the dashboard. Build and rsync it (§2).

---

## 7. Capacity

`game_tracker_snapshots` is by far the largest table — roughly 7 GB / 20M rows
for three months of three trackers, growing about **1.5 GB per month**. All
trackers currently have `retain_raw_days = NULL`, meaning raw data is kept
forever.

Daily aggregates already exist in `game_tracker_channel_day_stats`, so most
queries don't need old raw rows. Disk is not a near-term concern (114 GB free
at the time of writing), but setting a retention window is the lever if it
becomes one.

**Deleting production data needs explicit sign-off.** Preview with a `SELECT`,
delete with the *same* predicate inside a transaction, and verify the row count
matches the preview before `COMMIT`.

---

## 8. Backups

A nightly `pg_dump` runs at 03:00 UTC via cron
(`deploy/daily-backup.sh`), and `deploy/update.sh` takes another before every
deploy, retaining the last 10. See [backups.md](backups.md).
