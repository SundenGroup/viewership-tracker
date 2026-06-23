# Twitch cohost: extract per-channel slice from the Shared Viewership popup DOM

**Status:** Extractor implemented (v6, 2026-06-23), pending live validation. DOM-only. The GraphQL approach is **abandoned** — see below. Approach D (source-aware ingestion) is **deferred** by decision: correctness is already handled by the Helix fallback, so D only buys freshness-consistency — revisit only if a live broadcast shows the value flapping between real-time and stepped.

**What's landed (`scripts/twitch-browser-scraper.ts`):** the v6 cohost extractor in `readViewerCount` — detects cohost by the Shared Viewership popover actually opening (not the obsolete "Main Broadcast" text), maps each row by its `<a href="/{login}">` anchor (not localized display text, not `Math.min`), derives the host slice via `total − Σ(other exact rows)` when its display is rounded, and **abstains (writes nothing → Helix carries) when it can't confidently resolve a slice — it never writes the combined badge for a cohosting channel.** `refreshChannelList` is now cohost-allowlist-aware: with `COHOST_CHANNELS` unset, behaviour is byte-identical to before; activation is a pure env-var flip. Pure-logic (parsing/mapping/precision/abstain) validated by a 19-case test; typecheck clean. The only unverified piece is whether the **live** popover DOM matches the assumed structure (header label + per-row href) — that is Phase 0 / Phase 3 below.

**To activate at the next broadcast:** set `COHOST_CHANNELS=pubg_battlegrounds,kr1stw,pubg_taiwan,pubgjapan,<other co-streamers>` and `COHOST_DEBUG=1` on the relay PC, restart the scraper, and watch the `cohost slice=…` / `cohost extract FAILED …` log lines to confirm the selectors resolve before trusting the data.

> **Filename note:** kept as `...-graphql.md` for link stability, but the GraphQL primitive this doc originally proposed is dead. The approach is now pure DOM scraping of the Shared Viewership popover.

## Why GraphQL is dropped (do not revive)

The original plan's "clean primitive" was the page-context call to `gql.twitch.tv` for `user.stream.viewersCount`, on the assumption it updates every ~30-60 s. **That assumption is false and has now been disproven multiple times, most recently 2026-06-23 with multi-sample side-by-side tests:**

- `gql.twitch.tv` `user.stream.viewersCount` returns **byte-identical values to Helix `/streams.viewer_count`**, and both **step on the same 3-5 min cadence** (they plateau for minutes, then move together — zero divergence across 30+ samples on high-traffic channels).
- There is therefore **no real-time advantage to any GraphQL field**, and the *entire reason the browser scraper exists* is that the rendered **DOM viewer count updates ~every 60 s** — finer than the stepped API.

Conclusion: the only real-time Twitch signal available to us is the **DOM**. Per-channel cohost data must come from the rendered **Shared Viewership popover**, not from any API/GraphQL call. Do not reopen the GraphQL path.

## The goal

During Stream Together (cohost) broadcasts — PUBG_Battlegrounds with co-streamers (kr1stw, pubg_taiwan, pubgjapan, etc.) — the player renders ONE combined viewer badge (e.g. `6,395`). We want the per-channel slice for each tracked participant at the same ~60 s cadence we already get for non-cohost channels, read entirely from the DOM.

The data exists in the UI: clicking the badge opens a **"Shared Viewership"** popover listing every participant with their own count (observed 2026-06-23: 西南69→4.6K, はなふぶき→21, PUBGJAPAN→501, PUBG_Taiwan→1.2K, じぇま→27, total 6,395).

## Why the current scraper fails on cohost (confirmed against code)

`scripts/twitch-browser-scraper.ts`, `readViewerCount` (~280-642):

1. **Double kill-switch.** The cohost extractor only runs for channels in `COHOST_CHANNELS` (unset in prod → hard short-circuit at ~509-519 returns the combined badge). Separately, `pubg_battlegrounds` is filtered out of the scrape list entirely at `refreshChannelList` (~88-90).
2. **Feature-detection gate fails closed.** Extraction only fires if the page text matches `Main Broadcast` / `Co-Streamers` / `co-streaming` (~526-530). Twitch **renamed** the feature to **"Shared Viewership"** — those strings no longer exist on the page, so the gate never opens.
3. **Name matching is structurally wrong (root cause).** `findSlugRow` (~438-500) matches DOM **text equal to the login** (`kr1stw`) or `<a href="/kr1stw">`. The popover rows render **localized display names** (`西南69`), which never equal the login as text. The text strategy can never fire. The href strategy is the only correct hook but was never verified against the current popover DOM.
4. **`Math.min` pick bug.** Even on a match, `evaluateAncestor` (~455) picks the *minimum* child number — in a multi-row popover the host (4.6K) is NOT the minimum, so it can return a co-streamer's `21`.

## Ingestion landmine (must fix alongside — Approach D)

`src/api/routes/relay.ts` POST `/twitch` (~227-288) is **unconditional REPLACE / last-writer-wins** (273-280, log says `"replaced with browser data"`). The MAX-if-higher rule exists only on the *TikTok* path. Two sources POST to this endpoint with **no source discriminator**:
- browser scraper (60 s) → `scripts/twitch-browser-scraper.ts`
- gql relay (30 s) → `scripts/twitch-relay.ts`

So whichever writes **last** for a poll tick wins. A correct browser per-channel slice is silently clobbered the instant the gql relay writes its stepped/combined value. The relay also only **UPDATEs** rows at an exact-equal `pollTimestamp` (264) — it never inserts — so the orchestrator's base row must already exist at that tick.

**Fix:** add a `source` discriminator + source-priority resolution (browser > gql_relay > orchestrator) so a lower-priority writer can never overwrite a higher-priority per-channel value, and store the combined total in its own `cohost_combined` column so it can never be merged into a participant's count.

## Plan

### Phase 0 — Live DOM capture (BLOCKING; next cohost broadcast, ~10 min)

On the persistent-profile Chrome (CDP 9224) during an active Stream Together broadcast, open the Shared Viewership popover and record in this doc:

- **Trigger:** confirm the popover mounts on **click** of the `N ▼` badge (not hover), and how long until rows are in the DOM.
- **Row anchor (the mapping key):** does each participant row contain (or sit inside) an `<a href="/{login}">`? Capture the exact `outerHTML` of one row. This is the entire premise of robust mapping — the href carries the canonical login regardless of localized glyphs.
- **Selectors:** `data-a-target` / `data-test-selector` / `role` / `aria-label` on: the popover container, each row, the per-row count span, and the total header.
- **Exact values:** is the combined total exact in the DOM (`6,395`)? Do rounded counts (`4.6K`) carry an exact integer anywhere (`title=` / `aria-label=`)?
- **Freshness:** sample the popover's per-channel numbers every ~30 s for a few minutes. Do they move at the ~60 s badge cadence (real-time) or plateau like the API (stepped)? This decides whether co-streamer slices are real-time or whether only the host (via subtraction from the real-time total) is.

No network tab / no GraphQL inspection needed — this is purely DOM.

### Phase 1 — Source-aware ingestion (Approach D) — do now, no broadcast needed

1. **Migration:** `viewership_snapshots.source TEXT NOT NULL DEFAULT 'orchestrator'`, `cohost_combined INTEGER NULL`, index `(channel_id, timestamp, source)`. Backfill existing → `'orchestrator'`.
2. **Migration:** `channels.is_cohosted BOOLEAN NOT NULL DEFAULT false` (ideally per-broadcast-day, not static — aligns with day-aware tracking). DB-driven roster replaces the drifting `COHOST_CHANNELS` env + the hardcoded list in `fix-pnc2026-costream-data.ts`.
3. **`relay.ts` POST `/twitch`:** parse `source` (default `orchestrator`) + optional `combined`; replace the unconditional UPDATE with **source-priority**: `{browser:3, gql_relay:2, orchestrator:1}`, write only when incoming priority ≥ stored row's source priority; write `combined` to `cohost_combined`, never into `concurrent_viewers`; for `is_cohosted` channels, reject any combined-magnitude write into a participant's count.
4. **Pushers tag source:** orchestrator inserts → `orchestrator`; `twitch-relay.ts` `pushToServer` → `gql_relay` (fix stale `"updated (higher)"` log); `twitch-browser-scraper.ts` `pushToServer` → `browser` (fix stale log).
5. **Read paths** (`public.ts` ~199-205, `viewership.ts` ~64-68): change per-channel dedup from `Math.max`-across-rows to highest-priority-source (max-within-source tiebreak); read `cohost_combined` separately, never sum into per-channel totals.
6. **`relay.ts` GET `/twitch/browser-channels`:** move the `pubg_battlegrounds` protection server-side (flag via `is_cohosted`) so it's not one client-side line.

### Phase 2 — DOM popup extractor (Approach A) — after Phase 0 confirms the row anchor

In `scripts/twitch-browser-scraper.ts`, replace the cohost branch of `readViewerCount`:

1. **Open:** click the viewer-count badge trigger; wait for the popover portal to mount (poll for the container selector from Phase 0, ~500-900 ms).
2. **Enumerate rows:** for each participant row read `{ href → login, countText }`. Map login → tracked channel via `channels.channel_identifier` server-side (same join the relay uses at `relay.ts:262`). **Never** match on visible text; **never** use `Math.min`.
3. **Precision:** parse exact small counts directly. For the host / any rounded row, derive `host = combinedTotal − Σ(other exact rows)`. This is exact when ≤1 row is rounded; if multiple rows are rounded, the error compounds (±50 per rounded row) — **abstain to the combined badge rather than guess**.
   - **Freshness bonus:** because `combinedTotal` (the badge) is real-time, `host = realtimeTotal − Σ(others)` gives the host a **real-time** value even if the popover's own per-channel numbers turn out to be stepped. The host is the dominant channel, so this is the one that matters most.
4. **Emit multiple slices:** one cohost tab now contributes `{identifier, viewers, source:'browser'}` per mapped participant, plus `combined:<badge>` on the host entry. Update `pushToServer` + the result shape.
5. **Replace the gate:** detect cohost by the **"Shared Viewership" / "Total Viewers"** popover (not the obsolete `Main Broadcast`). Retire `findSlugRow` / `evaluateAncestor` / `trySeed` / `Math.min`.
6. **Un-gate:** remove the `pubg_battlegrounds` scrape-list filter once D's server-side guard is live. Keep `COHOST_CHANNELS` (or the `is_cohosted` flag) as the kill switch.

### Phase 3 — Verify on a live broadcast

1. Confirm one slice per tracked participant, keyed by correct login; host ≈ `4,646` (±1%), **not** `6,395`.
2. **Clobber-resistance (proves D):** with browser + gql relay both running, watch a single `(channel, tick)` row — host must hold the browser slice and never flip to the combined or a stepped gql value, regardless of arrival order. Grep `[Relay]` logs to confirm which sources actually push.
3. **Combined isolation:** `6,395` lands only in `cohost_combined`, never a participant's `concurrent_viewers`; summed series totals don't double-count it.

## Hard guards (so a combined/bled value can never be written again)

- **Server (D):** `is_cohosted` channels reject combined-magnitude writes into `concurrent_viewers`; combined → `cohost_combined` or dropped. Structural backstop independent of the extractor.
- **Extractor:** keep `>0`, `≤combined`, `<500000`; add `slice !== combined`; for the subtraction path require `|combined − Σ(allRows)|` within the rounding band before trusting it. Select host strictly by login. On any doubt, abstain to the combined badge (safe under D because it's tagged + isolated).

## Open questions (live-DOM only — resolve in Phase 0)

- Does each popover row carry `<a href="/{login}">`? (Mapping depends on it; if absent, fall back to a prefetched `displayName→login` dict from `getUsersByLogin` over the known roster — works only for rosters we already track.)
- Is the combined total exact in the DOM, and do rounded counts expose an exact integer in `title`/`aria-label`?
- Do the popover's per-channel numbers move at badge cadence (real-time) or step like the API?
- Does Twitch's gql/Helix report **combined or per-channel** under the host login during cohost? (Determines whether the orchestrator base row is poisoned at insert time, i.e. whether D's protection needs the relay to *insert* a row when none exists at the tick rather than silently dropping.)

## Not in scope

- Any GraphQL/Helix-based per-channel primitive — proven equivalent and stepped; abandoned.
- Twitch's official Embedded Broadcast API (stream-key holders only).
- Multi-stream YouTube (different problem, already shipped).

## History (for posterity)

- v1-v5 DOM attempts (May 2026) failed because they matched the **login as text** against **localized display names**, gated on the **obsolete "Main Broadcast"** marker, and picked `Math.min`. The href-anchor path — the one that could work — was never correctly isolated.
- May 8 broadcast wrote 15 combined-badge values for channel `f1a5d7cc-117f-4dea-bef9-0fbd7f5ec9a7`; removed, backup in `viewership_snapshots_backup_pubg_bg_cohost_20260508`.
- 2026-06-23: gql == Helix == stepped re-confirmed; co-streamer cohost data for PNC2026 cleaned and replaced; official CSV imported. This revision dropped GraphQL.
