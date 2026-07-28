# YouTube live tracking in Discover — how Playboard does it, and how we can

> **Status: SHIPPED 2026-07-28** (phases 1–4). Live on `pubg-battlegrounds`.
> First production cycle: roster 46 → 41 live → **1 quota unit**, gating split
> allow 0 / review 7 / deny 34. The deny pile was almost entirely BGMI —
> including a 10,857-viewer mobile stream that would otherwise have landed in
> the PC tracker, which is the whole argument for §4 in one row.
> Verified end-to-end: snapshots → stream_sessions (language detected: ru, vi)
> → chat pool opening InnerTube sessions. Remaining: §6 phase 3 (shadow-mode
> comparison) and better game/category classification — see "Next" at the end.
>
> Original status: proposal. Supersedes the "Phase 5 — YouTube reintroduction" stub in
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

## 5b. Per-stream depth — can we match Twitch/Kick? (verified 2026-07-28)

Live viewer counts alone would be a thin Discover. Everything else we show per
stream is reachable, and nearly all of it rides along in the *same* 1-unit call.

**Free in the `videos.list` call we're already making** (verified on 6 live
strangers' streams):

| Field | Gives us |
|---|---|
| `concurrentViewers` | the CCV curve → peak / avg / viewer-minutes / duration, computed exactly as today |
| `snippet.title` | title-change history by poll-over-poll diff, same as Twitch/Kick |
| `liveStreamingDetails.actualStartTime` | **exact** stream start (better than Twitch, where we infer it) |
| `snippet.defaultAudioLanguage` | language attribution (`en`, `hi`, `ru`, `zxx` observed) |
| `snippet.categoryId` | coarse category (20 = Gaming) |
| `liveStreamingDetails.activeLiveChatId` | present on **every** live stream — chat is addressable |

**Subscribers — the one genuine downgrade.** `channels.list?part=statistics`
costs 1 unit per 50 channels, but YouTube rounds public subscriber counts to
three significant figures (observed: 61000, 105000, 901000, 350000, 74200).
Per-stream follower delta — which we chart for Twitch/Kick — is therefore
**invisible for any channel above ~1k subs**. Options: keep the tile hidden on
YouTube rows, or show only long-horizon (weekly) growth where the rounding
step is finally crossed. Do not fabricate precision here.

**Chat — works, and InnerTube is the only viable path.**
- The official `liveChatMessages.list` must be polled every few seconds per
  stream; at ~5s that is **17,280 units/day for a single stream**. Non-viable.
- The InnerTube endpoint YouTube's own chat iframe uses costs zero quota.
  Verified from our datacenter server: `GET /live_chat?v=<id>` yields the
  InnerTube key + continuation token, then
  `POST /youtubei/v1/live_chat/get_live_chat` returns 200 with chat actions,
  a next continuation and a `timeoutMs` (10s observed). Real messages with
  `authorExternalChannelId` extracted successfully → feeds
  `chat_minute_rollup` (messages + unique chatters) unchanged, which unlocks
  engagement metrics and **health scoring on YouTube streams**.

**Scaling caveat for chat.** The shape differs from our existing collectors:
Twitch IRC multiplexes hundreds of channels over one connection, Kick Pusher
likewise; YouTube needs **one long-poll loop per stream** (~1 request/10s
each). 100 streams ≈ 10 req/s — real but manageable, and it must be selective.
The existing dials already cover this: `CHAT_MIN_CCV`, `CHAT_MAX_CHANNELS`,
`CHAT_TRACKER_QUOTA`. Add politeness/backoff; treat it as unofficial and
fail-soft, like the Kick resolver.

**Net position vs Twitch/Kick:**

| Per-stream metric | Twitch / Kick today | YouTube |
|---|---|---|
| CCV curve, peak, avg, hours watched | ✓ | ✓ (same 1-unit call) |
| Title + change history | ✓ | ✓ (free) |
| Exact stream start | inferred | ✓ **better** |
| Language | ✓ | ✓ (free) |
| Game/category | authoritative ID | ✗ our gating rules (§4) |
| Follower/sub delta | exact | ⚠ rounded to 3 s.f. |
| Chat messages / unique chatters | IRC / Pusher | ✓ InnerTube (proven) |
| Health score + evidence | ✓ | ✓ once chat lands |
| Session lifecycle, rollups, retention | ✓ | ✓ unchanged (platform-agnostic) |

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

## 8. What shipped (2026-07-28)

| Piece | Where |
|---|---|
| Schema: `youtube_enabled`, `youtube_config`, gating table | `migrations/20260728120000_youtube_discover.ts` |
| Batched live details + channel stats | `src/adapters/youtube.ts` (`getLiveVideos`, `getChannelStats`) |
| Live-search discovery (zero quota) | `src/services/youtube-live-discovery.ts` |
| Roster → track → gate | `src/services/youtube-game-tracker.ts` |
| Cycle integration, subs, avatars | `src/services/game-tracker-service.ts` |
| Gating decisions model + admin API | `src/models/game-tracker-youtube-channel.ts`, `src/api/routes/game-trackers.ts` |
| Review queue UI (admin) | `pages/discover/DiscoverYouTubeGating.tsx` |
| InnerTube chat pool | `scripts/lib/youtube-chat.ts` + `scripts/chat-collector.ts` |

Measured quota: **1 unit per poll cycle** for ~40 streams, i.e. ~1,440
units/day at 60s cadence — well inside one key, exactly as §2 predicted.

Discovery cadence is deliberately decoupled from the tracker's poll interval
(`youtube_config.discoveryIntervalSeconds`, default 600s, floor 120s): the
official APIs may be called every cycle, an unofficial page should not be.

### Next — the open problem

Keyword gating carries the load today and it is blunt: it denied
`WarriorislivE` and `HEADSHOT KING` for "no include keyword" when they may
well be PC players, and it would wave through a mobile stream that simply
never types "BGMI". Ideas worth testing, cheapest first:

1. **Channel-level memory is already doing the heavy lifting** — one decision
   per channel, forever. Most of the tail is repeat channels, so the queue
   should shrink fast. Measure that before building anything cleverer.
2. **Signals we already fetch but ignore:** `defaultAudioLanguage` (BGMI skews
   hi/ur), title emoji/hashtag patterns (`#bgmilive`), channel subscriber
   profile, whether the same channel also streams to Twitch/Kick under a
   known category.
3. **The watch page's game card** (`richMetadataRenderer`) is authoritative
   when present — absent on small streams, but a cheap confirm for big ones.
4. **Ask-style LLM classification** of ambiguous titles, run once per channel
   (not per poll) and written into the gating row as a suggestion for the
   human, never as an auto-allow.
