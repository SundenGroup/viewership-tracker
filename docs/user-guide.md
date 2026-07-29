# Clutch Viewership Tracker — User Guide

For anyone reading the numbers: analysts, partner managers, tournament staff,
stakeholders. No admin rights needed for anything in this guide.

If you run the tracker — adding games, approving channels, importing data,
deploying — read the [Admin Guide](admin-guide.md) instead.

---

## 1. The two halves

The tracker does two different jobs, and knowing which one you're looking at
explains almost every "why does this number look like that?" question.

| | **Explore** | **Discover** |
|---|---|---|
| Question | "How did *our event* perform?" | "Who is streaming *this game* right now?" |
| Scope | A curated roster of channels | Everything we can find |
| Organised by | Series → broadcast day → stage | Game tracker |
| Roster | Hand-picked, verified | Auto-discovered, then filtered |
| Use it for | Official reporting, partner decks | Market view, scouting, trends |

**Explore is authoritative. Discover is comprehensive.** When a number has to
be defensible in a partner deck, take it from Explore. Discover's job is
breadth, and breadth means some noise.

---

## 2. Explore

### Series, days and stages

A **series** is one tournament (PUBG Nations Cup 2026). It contains
**broadcast days**, and each day contains **stages** (Group Stage, Finals).
Viewership is recorded against all three, so you can ask "peak of the whole
event", "peak of day 4", or "peak of the Grand Final" and get consistent
answers.

A day's status tells you where it is:

- **scheduled** — hasn't started
- **live** — being polled now
- **completed** — finished; numbers are final

Series status (`active` / `completed`) is set by hand and is **organisational
only** — it does not control polling. An `active` series with no live days
isn't collecting anything, and that's normal.

### Reading the numbers

**CCV (concurrent viewers)** is a snapshot, not an audience total. 10,000 CCV
means 10,000 people were watching *at that moment*, not that 10,000 people
watched the event.

**Peak** is the highest single reading in the window. It's the headline number
most of the industry quotes.

**Average CCV** is the mean across the window. Lower than peak, and usually the
fairer comparison between two events of different lengths.

**Hours watched** = average CCV × hours broadcast. This is the number that
scales with duration, so it's the one to use when comparing a 3-hour final
against a 9-hour group stage.

### The co-streaming trap

If a tournament is co-streamed, adding up every channel double-counts nobody —
each viewer is on exactly one channel. But **Twitch cohosting is different**: a
cohosted stream shows the host's viewers on the guest's channel too. The
tracker handles the known cases, but if a number looks impossibly large during
a cohost, that's the first thing to suspect.

### Exports and reports

Any table exports to CSV. Reports are shareable HTML pages with a fixed
snapshot of the data — safe to send outside the company, and they don't change
when the underlying data is later corrected.

---

## 3. Discover

### Game trackers

A **game tracker** watches one game across Twitch, Kick and YouTube. It finds
live streams, polls them every cycle, and keeps history.

Each tracker has three tabs:

**Live** — what's on air right now. The leaderboard is sorted by current CCV.
This is the "what's happening" view.

**Trends** — the same data over time: 1h / 6h / 24h / 7d / 30d. Use this for
"is this game growing?" and "when does this game peak?"

**Channels** — every channel we've seen, with peak, average, hours live and
days streamed over the window. This is the scouting view.

The **platform filter** (top right) applies to all three tabs at once and is
part of the URL, so a filtered view is shareable.

### Streams and channels

Click any row to open a **channel page** — their history, their streams, their
health over time.

Click a stream to open the **stream page** — the CCV curve for that single
broadcast, chat activity, and the health breakdown.

### Search

The search box searches **stream titles and channel names** across history. Use
it to answer "has anyone streamed PNC before?" or "who was talking about this
patch?"

---

## 4. Stream health, and what a grade actually means

Every stream gets a score out of 100 and a letter. **The letter is a pure
function of the score** — the same score always gets the same letter:

| Grade | Score | Meaning |
|---|---|---|
| **A** | 85+ | Strong engagement, natural curve |
| **B** | 70–84 | Healthy |
| **C** | 55–69 | Unremarkable — the default for a stream with nothing wrong |
| **D** | 40–54 | At least one real red flag |
| **F** | <40 | Serious problems, or a critical flag |

### The important part: D and F are reserved

A stream can't get a D or an F just for being small or unpopular. Those grades
require **actual red flags**. A stream with no flags is floored into C even if
it ranks at the very bottom of its cohort.

That's deliberate. The point of the grade is to surface streams worth a second
look — not to rank popularity.

### What the score is built from

- **Engagement (40)** — chat activity relative to viewers, versus other
  streams of similar size
- **Curve shape (30)** — do the viewer numbers move like a human audience?
- **Followers (15)** — audience size versus the channel's following
- **Chat response (15)** — does chat react when viewership moves?

All of it is **cohort-relative**: a 200-viewer stream is judged against other
200-viewer streams, never against a 20,000-viewer one.

### What an F is really saying

The classic viewbot signature is a **flat line that ignores the rhythm of the
broadcast** — viewership that doesn't dip during breaks or spike during a big
moment, because it isn't reacting to anything. Combine that with near-zero chat
and you have an F.

**An F is a flag, not a verdict.** It says "this doesn't look like an organic
audience" — the causes range from bot traffic to embeds on a third-party site
to a stream that's mostly background noise on someone's second monitor. Treat
it as a prompt to look, not as an accusation to repeat.

---

## 5. Reading YouTube numbers with care

YouTube behaves differently from Twitch and Kick in ways that matter:

**YouTube doesn't say what game is being played.** There is no game field —
YouTube retired it in 2019. Every gaming stream is just "category 20". So a
channel only counts toward a game after a person approves it, and their
individual streams are matched on the **title**. If a streamer doesn't name the
game in their title, that stream won't be counted.

**Live viewer counts can be inflated in ways that later evaporate.** YouTube
discards low-quality playbacks after the fact, so a stream can show thousands
of live viewers and end with a few hundred total views. If a YouTube number
looks too good, check the VOD's view count.

**Subscriber counts are rounded** to three significant figures (61,000 —
not 61,431). Short-term subscriber changes are meaningless; only long-horizon
growth is real.

---

## 6. Quick answers

**"Why is a channel missing from Discover?"**
Most likely it's a YouTube channel awaiting review, or its title didn't name
the game. Pending channels are deliberately *not* counted — a missing number
is better than a wrong one.

**"Why did the number change after the event?"**
Corrections. Official CSV data replaces scraped estimates when we get it, and
mis-attributed streams get removed. Reports keep their original snapshot.

**"Peak here doesn't match peak there."**
Check the window and the platform filter. Peak over 24h ≠ peak over the event.

**"Two channels show identical viewers at the same minute."**
Known artifact of the Twitch browser scraper occasionally bleeding a value
across tabs. Flag it — it's a data bug, not a real tie.

**"Is Discover's total the real audience for this game?"**
No. It's the audience on channels we found and approved. Treat it as a strong
sample and a reliable trend line, not a census.
