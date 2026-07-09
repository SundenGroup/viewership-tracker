# Stream Integrity Signals — viewbot detection & health scoring

*Research 2026-07-09. Goal: partner-facing guidance separating super-healthy
streams from likely-inflated ones, built ONLY on data we already collect
(per-minute CCV, per-minute chat messages/unique chatters, follower
snapshots, stream sessions). Detection/guidance only.*

## Industry detection methods (external)

- **Chatters/viewers ratio** is the backbone signal everywhere: dead chat
  under a big viewer count. botted.wtf flags live channels with active-
  chatter engagement **<10% at ≥100 CCV**; community heuristics put healthy
  unique-chatters/CCV higher for small channels, lower for big ones —
  which is why cohort-relative baselines (not fixed thresholds) matter.
- **Curve shape**: bot traffic reads flat (unnaturally low variance), or
  drops in huge synchronized chunks (services stopping un-staggered), or
  spikes with no trigger (no raid, no title/category change, no co-stream).
- **Followers-vs-viewers**: hundreds of CCV with almost no follower
  conversion; follower growth not tracking viewer growth.
- **Chat quality**: chatbot fillers (repeated emoji, generic praise,
  gibberish) when botters fake chat too.
- **Registered-viewer ratio** (Twitch-internal): not observable to third
  parties — we skip it, like everyone else outside Twitch.
- Scale context for partners: analysts report suspicious channels on Kick
  surged 164% (7.7K → 20.3K) Q2→Q3 2025.

## Signals WE can compute (mapped to our schema)

1. **Engagement percentile** — per session: mean(unique chatters per
   minute ÷ CCV per minute) from `chat_minute_rollup ⨯ game_tracker_snapshots`,
   ranked against the **cohort** = same tracker (category) AND same size
   band (CCV decile). Cohort-relative is our edge: 3% chat ratio is normal
   for a 50k-CCV channel and damning for a 300-CCV one; watch parties chat
   less than solo streamers — the game-tracker corpus provides the honest
   baseline nobody else has per category.
2. **Curve organicness** — from per-minute CCV per session:
   (a) noise floor: coefficient of variation vs cohort (too-flat = flag);
   (b) step discontinuities: |Δccv| > 35% of level within 1–2 min not at
   session start/end; (c) spike-without-cause: rise > cohort p99 rate with
   no title/category change (we store title changes) and no simultaneous
   donor-drop elsewhere in the category (raid proxy).
3. **Follower conversion** — followers gained per 1k viewer-hours
   (`channel_follower_snapshots` deltas ÷ session ccv_minutes), vs cohort.
4. **Chatter response to spikes** — organic viewer spikes move chatters;
   bot spikes don't: corr(Δccv, Δchatters) over the session.
5. **Persistence** — flags across a channel's last N sessions (one weird
   session ≈ noise; five ≈ signal).
6. *(Phase 2)* **Chat quality** — extend the collector with cheap per-minute
   aggregates: distinct-message ratio (hash), median message length,
   top-message repeat share. No message content stored, GDPR-light.

## False-positive classes (must be surfaced, not hidden)

Raids/hosts (legit spike), embeds & co-stream portals (legit low chat),
TV-style watch parties, music/ambience streams, subathon sleep segments,
our own chat-coverage gaps (collector covers top ~150 live channels;
sessions without chat data get NO engagement score, never a zero).

## Product: "Stream Health" (positioning: health first, accusation never)

- **Per-session Health panel** (stream page): Engagement percentile chip,
  curve flags with plain-language evidence ("viewer count flat within ±1%
  for 74 consecutive minutes — organic curves in this cohort vary ±9%"),
  follower conversion, overall grade A–F.
- **Channel Integrity tab**: grade trend across sessions.
- **Tracker-level partner screen**: "Healthiest channels" (the sponsor
  shortlist — the actual product) + "review recommended" list. Green badge
  = verified-healthy is the partner-facing value; red is internal-first.
- **Scoring**: composite 0–100 = weighted subscores (engagement 40, curve
  30, followers 15, spike-response 15), computed nightly for ended
  sessions with ≥50 avg CCV AND chat coverage; grade withheld when data
  insufficient. Always shipped WITH evidence, labeled "signals, not proof".

## Phasing

- **P1 (~3d):** nightly scorer (SQL over existing tables) + stream-page
  Health panel + channel grade trend.
- **P2 (~2d):** collector chat-quality aggregates + subscore; Kick chatroom
  lookups via the residential relay box (datacenter 403 workaround).
- **P3 (~2d):** partner screen (healthy shortlist + export), percentile
  badges, methodology page (trust doc — same philosophy as the export
  granularity work).
