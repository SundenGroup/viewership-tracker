# Clutch Viewership Tracker — Editor Guide

For the people who run event rosters day to day: adding channels, working
review queues, keeping a live broadcast tracked. Everything in this guide
works with the **editor** role (admins have all of it too).

If you only read the numbers, the [User Guide](user-guide.md) is shorter and
explains what they mean. Server operations — deploys, API keys, user
accounts — live in the [Admin Guide](admin-guide.md).

---

## 1. Your permissions at a glance

| You can | Admin only |
|---|---|
| Edit a series' settings, keywords, view groups | Create or delete a series; change its status |
| Create, edit and delete stages and broadcast days | Switch a day between scheduled / live / completed |
| **Extend a live day's end time** | End a broadcast early |
| Add, edit, day-pin, re-tier and deactivate channels | Hard-delete a channel and its data |
| Approve, block and clear the Scout feed | Start or stop Scout and polling |
| Work the YouTube review queue and its matching vocabulary | Create or delete a game tracker; tracker polling config |
| Import CSVs, export per-minute data, build reports | Deeper export grains (minute totals, channel summary, raw polls) |
| Read polling and Scout status | YouTube API keys and quota pages; user accounts |

---

## 2. Running a broadcast day

A series contains **stages**, and stages contain **broadcast days**. You can
create and edit all of them; what you cannot do is flip a day's status —
going live and completing a day are admin actions, because polling starts
and stops with them.

### Extending a live day

The one schedule control you do have, and the one that matters most during a
broadcast: **Extend**. On a live day, the sidebar day row (and the day card)
offers +30 min steps. Extending pushes the day's scheduled end time into the
future so the tracker keeps polling past the plan.

Use it the moment a broadcast is running long. If the scheduled end passes,
the orchestrator completes the day and stops collecting — data missed that
way can sometimes be recovered from Discover, but only for platforms and
channels Discover was watching. Extending beforehand is free; reconstructing
afterwards is not.

Extend never shortens a day. If the broadcast ends early, ask an admin to
complete it.

---

## 3. The roster: channels

Add channels one at a time or in bulk from the sidebar. The conventions that
keep the data clean:

- **Display name** — use the name reports should show (for player streams,
  the in-game nickname).
- **Language and region** — set both; language drives the report language
  splits and view groups, so a missing language shows up as
  "uncategorized" in partner-facing reports.
- **Category** — Official / Player POV / Watch Party / etc. Categories are
  how reports break down the audience, so a miscategorised channel skews
  two numbers at once.
- **YouTube channels** — prefer the `UC…` channel id over an `@handle`.
  Both may resolve to the same channel, and a handle-added duplicate
  double-counts.

### Day tags

- A manually added roster channel defaults to **All Days** — it counts on
  every day of the series, no day rows needed.
- A **day-pinned** channel counts only on its pinned days. Rosters that
  stream on specific days (player streams, watch parties confirmed for
  certain days) should be pinned to those days.
- **Watch parties** should stay Scout-sourced and day-pinned rather than
  being converted to all-days manual channels — that way Scout can pick
  them up again on their next appearance.

### Deactivate vs delete

**Deactivate** stops polling but keeps every snapshot — reversible, yours to
use freely. **Delete** removes the channel and its data and is admin-only.
If a channel was added by mistake, deactivate it and tell an admin.

---

## 4. The Scout feed

While a day is live, Scout (formerly "auto-discovery") searches each
platform for streams matching the series' keywords. Hits land in the
**Scout feed** as scouted channels: already being recorded, but flagged
for a human look.

Three actions, all yours:

| Action | Effect |
|---|---|
| **Approve / promote** | Moves the channel into a proper roster tier. Its data is kept from first sighting. |
| **Block** | Removes it and stops it returning for this series. |
| **Clear** | Purges every unapproved discovered channel in one go. |

The feed also purges itself automatically whenever a broadcast day goes
live, so stale finds from yesterday don't linger into today.

If a channel you know should be tracked was scouted late (or slipped
through), an admin can usually backfill the missing hours from Discover —
say so early, while the day is still fresh.

---

## 5. Discover: the YouTube review queue

Discover trackers watch whole games, not events. Twitch and Kick declare a
stream's game; YouTube does not, so YouTube membership is a human decision.
The queue lives at **Discover → tracker → Channels** (YouTube section).

Three decisions per channel:

| Decision | Meaning |
|---|---|
| **Track matching** | Count only streams whose *title* matches the game's vocabulary. For variety streamers. |
| **Track all** | Count everything they stream in the Gaming category. For orgs and tournament channels. |
| **Exclude** | Never count this channel for this tracker. |

**There is no rush.** A pending channel is never counted, but its viewership
is *banked*: the queue row shows how much is held ("3h 12m banked"), and
approving copies the held data into the record with original timestamps.
Excluding discards it. The hold expires after **14 days** — the one deadline
that matters. Columns sort (Last Seen is usually the useful one) so you can
work the queue newest-first.

### The matching vocabulary

Editable in the same panel, and now editor work. The lists *are* the gating
rules — `include` is the main matching list, `strongPhrases` auto-approve
unknown channels, `exclude` drops a title outright. The single
highest-value habit: **when a new tournament starts, add its abbreviation
to `include`**, or Track-matching channels streaming it without naming the
game go uncounted.

---

## 6. Imports, exports, reports

- **CSV import** — for platform-exported session data. The importer
  cross-checks timestamps against our own polling and **blocks imports
  that look time-shifted** (wrong timezone in the export). If it flags a
  shift, check the export's timezone rather than forcing it through — a
  mis-zoned import quietly corrupts a whole day.
- **Exports** — per-minute CSV/XLSX/JSON is the authoritative grain and
  safe to sum. The deeper grains (minute totals, channel summary, raw
  polls) are admin-only.
- **Reports** — build and share HTML reports, including public links with
  view-group filters and comparison baselines. What you see is what
  partners get.

---

## 7. When you need an admin

- Create or delete a series; mark it active/completed
- Take a day **live**, **complete** it, or end it early
- Hard-delete a channel or any recorded data
- Start/stop polling or Scout; trigger manual cycles
- Backfill missed hours from Discover
- YouTube API keys and quota
- New game trackers or tracker polling settings
- User accounts and roles
