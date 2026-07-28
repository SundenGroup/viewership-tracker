# YouTube live tracking in Discover — how Playboard does it, and how we can

> Status: proposal. Supersedes the "Phase 5 — YouTube reintroduction" stub in
> `2026-05-05-live-game-tracker.md`, whose blocking assumption (quota
> competition) no longer holds and whose proposed gating mechanism
> (`topicDetails`) is empirically dead. All numbers below were verified against
> Google's docs and live API calls on 2026-07-28.

## 1. The mechanism (verified)

Getting live viewer counts for *someone else's* stream needs exactly one call:

```
GET /youtube/v3/videos?part=snippet,liveStreamingDetails&id=<up to 50 ids>
→ liveStreamingDetails.concurrentViewers per video
```

Verified live: 5 arbitrary strangers' PUBG streams returned `concurrentViewers`
25 / 94 / 112 / 51 / 8, plus `defaultAudioLanguage` (en, en-US, hi, ru) and
`categoryId` — in **one call costing 1 quota unit**.

**The load-bearing fact: `videos.list` costs 1 unit per *call*, not per ID.**
Fifty live streams cost the same as one. Everything below follows from that.

Two API facts worth recording:

- Google's docs note the API's `concurrentViewers` "might differ from the
  processed, despammed concurrent viewer counts available through YouTube
  Analytics" — i.e. **the API returns the raw, bot-inclusive number**. That is
  precisely what we want for integrity work (it's what made the FynTrix
  viewbot case legible: raw 9.2k live vs 258 despammed views).
- `videos.batchGetStats` (new, 2026-06-03; own 10k/day bucket, 1 unit) returns
  view/like/comment counts only — **no live viewers**. Useful later for VOD
  tracking, irrelevant here.

## 2. The economics — and why Playboard's buckets are 10 minutes

Cost to track N concurrent live streams at cadence C:

```
units/day = (1440 / C_minutes) × ceil(N / 50)
```

Per key (10,000 units/day):

| Streams tracked | 10-min cadence | 5-min | 1-min |
|---|---|---|---|
| 500 | 1,440 u | 2,880 u | 14,400 u (2 keys) |
| 3,000 | 8,640 u | 17,280 u (2 keys) | 86,400 u (9 keys) |
| 35,000 | 100,800 u (11 keys) | 22 keys | 101 keys |

Playboard tracks *all of YouTube* — tens of thousands of concurrent live
streams. At that N, 10 minutes is the only cadence that fits a sane key pool.
**Their bucket size is a quota artifact, not a product choice**, which is why
every series we pulled came back as `{period, interval: 600, viewerCount}`.

**This is our structural advantage: we don't need all of YouTube.** Scoped to
one game tracker (a few hundred live streams), we can afford **1–2 minute
cadence on one or two keys** — finer than Playboard, matching our existing
60-second Twitch/Kick polling.

What Playboard publishes about the rest of their crawl (tiered refresh: subs
daily; videos <7 days or >5k views daily; older videos every 2–365 days) is
consistent with a large channel index feeding a batched stats crawler. The
index + tiering is *inference* from their own published description; the
`videos.list` batching is the only mechanism that can produce what we observed.

## 3. What changed since the plan was parked (2026-05-05)

The plan deferred YouTube because "quota model needs to coexist with tournament
discovery" — discovery searches (100 units each) would eat the same 10k budget
the tournament poller depends on.

**As of 2026-06-01, `search.list` bills to its own quota bucket** (Google's
revision history: the API is "transitioning to a granular quota system…
`videos.insert` and `search.list` will be charged to their own respective
quota buckets"). Discovery searches no longer compete with polling. The
blocker is gone.

## 4. Gating — the plan's proposed mechanism does NOT work

The parked plan proposed `videos.list + topicDetails + title-substring
AND-gating`. Tested on live PUBG-PC and BGMI (PUBG Mobile) streams:

| Video | Game | topicCategories |
|---|---|---|
| shqyvdS4P3Q | PUBG PC | Action-adventure_game, Action_game, Video_game_culture |
| Rf7ebizxHk0 | BGMI (mobile) | Action-adventure_game, Action_game, Role-playing…, Strategy… |

`topicDetails` returns generic Wikipedia topics, never the specific game, and
**cannot separate PUBG PC from PUBG Mobile** — the exact discrimination a
"PUBG: BATTLEGROUNDS" tracker needs. `categoryId` is 20 (Gaming) for
everything. The watch page's game card (`richMetadataRenderer`) is absent on
most small streams. Scraped live-search results mix BGMI/PUBGM into "PUBG"
queries freely.

**Conclusion: YouTube has no reliable machine-readable game association.**
Unlike Twitch/Kick, where category IDs are authoritative, YouTube gating must
be *our* judgment, made explicit and persistent:

1. `categoryId == 20` as a coarse pre-filter.
2. Per-tracker **include/exclude keyword rules** on title (e.g. include
   `pubg|battlegrounds`, exclude `bgmi|mobile|pubgm|lite`) — an extension of
   the keyword gating `discovery-service` already does.
3. Per-tracker **channel allow/deny list** in admin — one human decision per
   channel, remembered forever. This is what actually makes it accurate.
4. Existing `min_ccv_threshold` to keep the long tail out.

Anything that fails the rules is *quarantined for review*, not silently
dropped or silently included.

## 5. Proposed architecture

Three layers; only the first two are new code.

**Discovery (which videos are live for this game)**
- *Primary, zero quota:* fetch `youtube.com/results?search_query=<alias>&sp=EgJAAQ%3D%3D`
  (the Live filter), parse `ytInitialData` → videoId, channel, title, "N
  watching". Verified working: 19 live entries in one fetch. Several aliases
  per tracker, paginated by continuation token.
- *Cross-check, own bucket:* `search.list?eventType=live&type=video` — ~100/day
  per key, no longer competing with polling. Used to catch what scraping misses.
- *Seeded:* channels we already know stream this game — re-check cheaply.
- Runs every ~10 min; the roster changes far slower than the counts.

**Tracking (the numbers)**
- Every cycle, batch all live videoIds 50-per-call through
  `videos.list?part=snippet,liveStreamingDetails`.
- Authoritative `concurrentViewers`, plus title/language/categoryId for free.
- Drop a video when `concurrentViewers` disappears (stream ended).
- **Never** attribute a count without confirming the videoId it came from —
  the EWC/FynTrix lesson: `/channel/UC…/live` redirects lie, `videos.list`
  by explicit ID cannot.

**Storage & everything downstream — no new code**
`game_tracker_snapshots` already keys on `(game_tracker_id, channel_id,
timestamp)` with `stream_id`/`stream_title`. Sessions, health scoring, chat
rollups, day-stats, retention, the whole Discover UI are platform-agnostic.
YouTube rows flow through unchanged.

## 6. Phasing

1. **YouTube roster + poller** behind a per-tracker `youtube_enabled` flag:
   discovery scrape → gating rules → `videos.list` batch → snapshots. Quota
   accounted through the existing pool with a per-tracker daily budget that
   yields to tournament polling under pressure.
2. **Admin gating UI**: keyword rules, channel allow/deny, quarantine queue.
3. **Backfill guard**: run one game shadow-mode for a week — record but don't
   publish — and compare against Playboard spot-checks before it goes live.
4. **YouTube chat** (optional, later): InnerTube live-chat gives message/chatter
   rates, which would extend health scoring + viewbot detection to YouTube.
   Currently Twitch IRC + Kick Pusher only.

## 7. Honest risks

- **Scraped discovery is unofficial.** Format can change without notice; needs
  the same defensive parsing (and fail-closed instinct) as the `/live` scraper.
  The `search.list` path is the supported fallback.
- **Gating is judgment, not data.** Expect ongoing curation; budget for it.
  Mis-gating is how a BGMI stream lands in a PC tracker.
- **Volume.** "All PUBG on YouTube" is a much longer tail than Twitch/Kick;
  `min_ccv_threshold` and retention policy matter more here.
- **Quota is shared.** A runaway YouTube tracker could starve tournament
  polling — hence per-tracker budgets and the yield rule.
