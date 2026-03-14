# Clutch Viewership Tracker — Role Permissions

Three roles exist: **Admin**, **Editor**, and **Viewer**. Permissions are cumulative — Admins can do everything Editors can, and Editors can do everything Viewers can.

---

## Permission Matrix

| Feature | Admin | Editor | Viewer |
|---------|:-----:|:------:|:------:|
| **Dashboard & Data** | | | |
| View dashboard, metrics, and charts | Yes | Yes | Yes |
| View channel list and discovery feed | Yes | Yes | Yes |
| **Exports & Reports** | | | |
| Export data (CSV, JSON, HTML) | Yes | Yes | - |
| Generate reports | Yes | Yes | - |
| **Series Management** | | | |
| Create new series | Yes | - | - |
| Edit series metadata | Yes | Yes | - |
| Delete series | Yes | - | - |
| Change series visibility | Yes | - | - |
| Toggle series public access | Yes | - | - |
| **Stages & Broadcast Days** | | | |
| Add / edit / remove stages | Yes | Yes | - |
| Add / edit / remove broadcast days | Yes | Yes | - |
| Change broadcast day status (Go Live / Complete) | Yes | - | - |
| **Channel Management** | | | |
| Add channels (single or bulk) | Yes | Yes | - |
| Edit channel metadata (name, language, region, tier, days) | Yes | Yes | - |
| Disable / enable channel | Yes | Yes | - |
| Delete channel (removes all data) | Yes | - | - |
| **Discovery** | | | |
| Approve discovered channels | Yes | Yes | - |
| Block discovered channels | Yes | Yes | - |
| Clear discovery feed | Yes | Yes | - |
| Start / stop / trigger discovery | Yes | - | - |
| **Polling** | | | |
| Start / stop live polling | Yes | - | - |
| Trigger manual poll cycle | Yes | - | - |
| **User Management** | | | |
| View / create / edit / delete users | Yes | - | - |

---

## Channel Actions by Role

Channels can be managed with three distinct actions, each with different data implications:

| Action | Effect | Data | Admin | Editor |
|--------|--------|------|:-----:|:------:|
| **Disable** | Stops polling | Preserved | Yes | Yes |
| **Block** | Stops polling + blocks re-discovery | Preserved | Yes | Yes |
| **Delete** | Removes channel entirely | **Deleted** | Yes | - |

- **Disable** is the safe default for removing a channel from active tracking while keeping historical data.
- **Block** is for discovery channels you don't want reappearing. Historical data is preserved.
- **Delete** is destructive — it cascade-deletes all viewership snapshots for that channel. Admin only.

---

## Role Summary

**Viewer** — Read-only access to the dashboard and all viewership data. Ideal for stakeholders who need to monitor metrics without making changes.

**Editor** — Can manage channels (add, edit, disable, block), stages, broadcast days, and series metadata. Can export data and generate reports. Can approve and block discovered channels. Cannot delete channels, control polling/discovery, or change broadcast day status. Ideal for team members actively managing tournaments.

**Admin** — Unrestricted access. Can delete channels (with data), control polling, discovery, broadcast day status, series lifecycle, visibility settings, and user accounts. Intended for operations leads.

---

## Public Access

When a series has the **Public** toggle enabled (Admin only), its dashboard and reports are viewable by anyone at `/public/{short_name}` — no login required. This provides read-only access to viewer-facing panels and generated HTML reports. Management features are excluded.
