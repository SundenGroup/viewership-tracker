# Clutch Viewership Tracker — User Manual

Welcome to the Clutch Viewership Tracker. This guide covers everything you need to manage tournaments, channels, and viewership data.

You currently have **Admin** access for testing purposes. This means you have full access to all features, including creating series and controlling polling/discovery.

**Login:** Navigate to [tracker.clutch.game](http://tracker.clutch.game) and sign in with the credentials shared with you.

---

## Dashboard Overview

After logging in you'll see the main dashboard. The top bar shows the currently selected series and navigation. The left sidebar contains the tournament schedule and channel management tools. The main area displays live viewership panels.

### Dashboard Panels

- **Summary Bar** — Key metrics at a glance (peak CCV, total viewed hours, active channels)
- **Total CCV** — Combined concurrent viewers across all platforms
- **Platform Breakdown** — Viewer split by Twitch, YouTube, Kick, TikTok, and Steam
- **Time Series Chart** — Viewership over time (zoomable). When viewing multiple broadcast days, vertical dashed lines mark each day's boundary with a label.
- **Channel Leaderboard** — Top channels ranked by peak/average CCV. Click the expand button to see detailed stats including tier, viewed hours, and live CCV.
- **Language Distribution** — Viewer breakdown by stream language
- **Region Distribution** — Viewer breakdown by region
- **Channel List** — All tracked channels with status and metadata. Click the expand button for more vertical space when managing 100+ channels. Defaults to showing active channels only — use the filter buttons to see all or inactive channels.
- **Discovery Feed** — Auto-discovered channels awaiting review. Expandable and includes a "Clear All" button to flush the feed manually. The feed is automatically purged when a broadcast day goes live.
- **Export** — Download data as CSV, JSON, or interactive HTML reports

---

## Managing Series

### Creating a Series

1. Click **New Series** in the top navigation bar
2. Fill in the series details:
   - Series name and short name
   - Game title
   - Partner name
   - Start and end dates
   - Discovery keywords (comma-separated terms used for auto-discovery)
   - Discovery Game IDs (platform-specific game identifiers for Twitch, YouTube, Kick)
3. Add stages and broadcast days (see below)
4. Click **Create** to save the new series

### Editing a Series

1. Select a series from the dropdown in the top bar
2. Click **Edit Series** in the navigation
3. Update any of the following:
   - Series name and short name
   - Game title
   - Partner name
   - Status (Draft / Active / Completed)
   - Start and end dates
   - Discovery keywords (comma-separated terms used for auto-discovery)
   - Discovery Game IDs (platform-specific game identifiers for Twitch, YouTube, Kick)
   - Discovery default tier (the tier assigned to channels approved from the Discovery Feed; defaults to "Community")
   - Public access toggle (makes the series viewable without login — see [Public Dashboard & Reports](#public-dashboard--reports) below)
4. Click **Save** to apply changes

### Managing Stages

Within the series editor, you can add, edit, and remove stages:

1. Scroll to the **Stages** section
2. Click **Add Stage** to create a new stage (e.g., "Group Stage", "Playoffs")
3. Set the stage name, start date, and end date
4. Click the trash icon to remove a stage

### Managing Broadcast Days

Each stage contains broadcast days — the individual streaming sessions to track:

1. Expand a stage to see its broadcast days
2. Click **Add Day** to create a new broadcast day
3. Set the label (e.g., "Day 1"), date, and broadcast start/end times
4. Click the trash icon to remove a day

### Broadcast Day Status

In the left sidebar schedule, you can change a broadcast day's status:

- Click **Go Live** on a scheduled day to begin live tracking (polling will start automatically)
- Click **Complete** on a live day to end tracking for that session

---

## Channel Management

### Supported Platforms

Channels can be tracked on five platforms: **Twitch**, **YouTube**, **Kick**, **TikTok**, and **Steam**.

### Adding Channels

**Single channel** — Use the form in the left sidebar:
1. Enter the channel URL or identifier
2. Select the platform (auto-detected from URLs)
3. Click **Add**

**Bulk add** — For adding multiple channels at once:
1. Click the bulk add button in the sidebar
2. Paste channel URLs or identifiers (one per line) — platforms are auto-detected from URLs
3. Submit

### Editing Channels

In the **Channel List** panel:

1. Click the edit icon on any channel row
2. Update the display name, language, region, tier, or assigned broadcast days
3. Save your changes

**Tier levels:**
- **Official** — Primary tournament broadcast channels
- **Partner** — Officially partnered co-streamers
- **Player** — Player POV streams
- **Community** — Community co-streamers
- **Watch Party** — Watch party streams

### Channel List Features

- **Sorting** — Click any column header to sort (Streamer, Platform, Category, Language, Days, etc.)
- **Filtering** — Toggle between Active, Inactive, or All channels using the filter buttons
- **Expand** — Click the expand button in the panel header to use more screen space (useful for 100+ channel broadcasts)

### Disable / Block / Delete

Three ways to handle a channel you no longer want actively tracked:

| Action | Stops Polling | Blocks Re-discovery | Preserves Data | Who Can Do It |
|--------|:---:|:---:|:---:|---|
| **Disable** | Yes | No | Yes | Editor, Admin |
| **Block** | Yes | Yes | Yes | Editor, Admin |
| **Delete** | Yes | N/A | **No** — removes all data | **Admin only** |

- **Disable** — Click the Disable button to stop polling. The channel stays in the list (hidden by default under the "inactive" filter) and all historical viewership data is preserved. Use Enable to resume tracking.
- **Block** — Available on auto-discovered channels. Stops polling, adds the channel to the series blocklist so it won't reappear in Discovery, and preserves all historical data.
- **Delete** — Permanently removes the channel **and all its viewership data** (cascade delete). A warning is shown: *"Deleting removes all historical data. Consider disabling instead to preserve it."* Requires confirmation. **Admin only.**

### Reports & Disabled/Blocked Channels

Reports are scope-aware: a channel only appears in a report if it has viewership data within that report's scope. For example, a channel disabled after Broadcast Day 1 will appear in BD 1 reports (where it has data) but not in BD 2 reports (where it has none). This applies regardless of the channel's current active/inactive status.

---

## Discovery Feed

The Discovery Feed shows channels that were automatically found by the system based on the series' discovery keywords and game IDs. It searches across all five platforms (Twitch, YouTube, Kick, TikTok, Steam).

### Reviewing Discovered Channels

Each entry shows:
- Channel name and platform
- Current stream title and viewer count
- Language detected
- Time discovered

### Approving a Channel

Click **Approve** to add a discovered channel to the tracked channel list. It will be assigned the series' configured default tier (defaults to "Community" if not changed in the series editor).

### Blocking a Channel

Click **Block** to reject a channel. Blocked channels are added to the series blocklist and won't appear in future discovery results. If the channel had already collected viewership data before being blocked, that data is preserved.

### Auto-Purge

When a broadcast day transitions to **live** status (either automatically or manually), the Discovery Feed is automatically purged — pending unapproved channels with no viewership data are removed. Channels that have already collected data are preserved.

### Clear All

Click the **Clear All** button in the Discovery Feed header to manually flush all pending channels. This follows the same rules as auto-purge: channels with historical viewership data are preserved.

### Expanding the Feed

Click the expand button in the Discovery Feed header to see more channels at once (similar to the Channel List expand feature).

### Discovery Controls

In the left sidebar under **Discovery**, you can:

- **Start** / **Stop** automatic discovery for a series
- **Trigger** a manual discovery scan to find new channels immediately

---

## Polling Controls

In the left sidebar under **Polling**, you can:

- **Start** / **Stop** live viewership polling
- **Trigger** a manual poll cycle to fetch the latest viewer counts

Polling runs automatically when a broadcast day is live. You can also trigger it manually at any time.

---

## Exporting Data

The **Export** panel lets you download viewership data for reporting.

### Available Formats

| Format | Best For |
|--------|----------|
| **CSV** | Spreadsheet analysis (Excel, Google Sheets) |
| **JSON** | Data processing and integrations |
| **HTML Report** | Shareable interactive report with charts |
| **Report Payload** | Structured data for PDF generation |

### Export Scope

You can export at three levels:
1. **Entire series** — All data across all stages and days
2. **Specific stage** — Data for one stage only
3. **Specific broadcast day** — Data for a single broadcast session

### Report Filenames

Generated report files are named based on the export scope:
- **Broadcast day** — `day_{date}.html` (e.g., `day_2026-03-07.html`)
- **Stage** — `stage_{stage-name}.html` (e.g., `stage_group_stage.html`)
- **Series** — `series_{date}.html` (e.g., `series_2026-03-08.html`)

---

## Public Dashboard & Reports

You can make a series publicly viewable — accessible without login via a direct link.

### Enabling Public Access

1. Go to **Edit Series** for the series you want to share
2. Toggle **Public** to on
3. A shareable URL will be displayed: `https://tracker.clutch.game/public/{short_name}`
4. Click **Save**

### What's Included

The public dashboard shows all viewer-facing panels with live real-time updates:
- Summary Bar, Total CCV, Platform Breakdown
- Time Series Chart (with broadcast day boundary markers)
- Channel Leaderboard, Language Distribution, Region Distribution

Management features are **not** included — no sidebar, no channel editing, no discovery feed, no export controls, and no polling controls.

### Public Reports

When a series is public, its generated HTML reports are also accessible without login at:

`https://tracker.clutch.game/api/public/{short_name}/reports/{filename}`

For example: `https://tracker.clutch.game/api/public/PUBGRace/reports/day_2026-03-07.html`

---

## User Management

As an admin you also have access to the **Users** page (accessible from the top navigation). Here you can view all user accounts. Please don't modify any accounts — this is managed centrally.

---

## Tips

- **Use discovery keywords wisely** — The more specific your keywords, the fewer irrelevant channels will appear in the Discovery Feed
- **Review discovery regularly** — New channels appear as streams go live; approve or block them promptly to keep the feed clean
- **Disable instead of delete** — If you no longer want to track a channel, use Disable (or Block for discovery channels) to preserve historical data. Only use Delete if you truly want to erase all viewership records for that channel
- **Export before a broadcast ends** — Run an export while data is fresh for the most accurate reporting
- **Check channel tiers** — Properly categorized channels (Official, Partner, Player, Community, Watch Party) help produce cleaner reports
- **Use the expand buttons** — Both the Channel List and Discovery Feed panels can be expanded for better visibility when managing large broadcasts
- **Filter active channels** — The channel list defaults to showing only active channels. Switch to "All" to see disabled/blocked channels when needed
