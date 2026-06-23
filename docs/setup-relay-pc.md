# Twitch Relay Setup — Windows PC

Standalone Twitch tracking on a dedicated Windows PC. Replaces the Twitch
piece on the 2019 MBP (which keeps doing TikTok, since that side is more
fragile and the Mac's already configured for it).

## Why a separate machine

A single Twitch tab in the persistent-profile Chrome the scraper uses
costs ~250 MB RAM and 10–20 % of one CPU core (paused video, viewer
count still updating via Twitch's GraphQL polling). On the 2019 MBP we
capped this at `MAX_CHANNELS=8` so the chassis doesn't thermal-throttle.
On a modern desktop with ≥32 GB RAM and a current-gen CPU you can run
40–50+ tabs without breaking a sweat — there's no real reason to keep
the cap.

## What this machine runs

| Tracker | Script | Notes |
|---|---|---|
| **Twitch browser-server** | `scripts/twitch-browser-server.ts` | Persistent Chrome with the saved Twitch login, exposes CDP on port 9224 |
| **Twitch browser-scraper** | `scripts/twitch-browser-scraper.ts --loop` | Polls every 60 s, pushes counts to `tracker.clutch.game` |

This PC is the **sole** Twitch source: the Mac drops its Twitch
services (keeps TikTok) once this is live — see §5. That matters because
the Twitch relay endpoint is **last-writer-wins (REPLACE), not MAX** —
the MAX-per-minute rule only applies to TikTok. So two Twitch scrapers
pointed at the same channels would overwrite each other minute-to-minute
(harmless for normal channels since they read the same value, but during
a cohost broadcast a non-cohost-aware scraper would clobber the correct
slice with the inflated combined badge). Run Twitch on exactly one box.

## 0. Prereqs

Install on the PC (skip what you already have):

1. **Node.js 22 LTS** — https://nodejs.org/ (default installer; tick "Add
   to PATH"). Confirm with `node -v` in PowerShell → `v22.x.x`.
2. **Git for Windows** — https://git-scm.com/download/win.
3. **Google Chrome** — https://www.google.com/chrome/. The scraper looks
   in `C:\Program Files\Google\Chrome\Application\chrome.exe` (and a few
   fallbacks); standard installers go there.

Open **PowerShell** for everything below. Avoid the Windows Terminal
"cmd" tab — some commands assume PowerShell semantics.

## 1. Clone + install

```powershell
cd $HOME
git clone https://github.com/SundenGroup/viewership-tracker.git clutch-viewership-tracker
cd clutch-viewership-tracker
npm install
```

`npm install` takes a couple of minutes the first time. Re-run after
`git pull` if `package.json` or `package-lock.json` changed.

## 2. `.env`

Same shape as the Mac's `.env`, minus the TikTok keys (this machine isn't
running TikTok). Copy `RELAY_URL` and `RELAY_SECRET` from the Mac's
`~/clutch-viewership-tracker/.env`.

```powershell
# In the repo root:
@"
RELAY_URL=https://tracker.clutch.game
RELAY_SECRET=<paste-from-mac>
"@ | Set-Content -Encoding ascii .env
```

> **No `MAX_CHANNELS`** on this box — let the scraper take the full
> server-supplied list. If you ever do need to cap it client-side, add
> `MAX_CHANNELS=N` to `.env`.

### Track more than 20 channels (server-side)

The number of channels the scraper receives is decided by the **server**,
not this PC — it returns officials + top-CCV capped at
`BROWSER_CHANNELS_LIMIT` (default 20). To use this PC's extra capacity,
raise that var **on the server** (`tracker.clutch.game`), not here:

```bash
# On the server (165.232.126.195), in /opt/clutch-viewership-tracker/.env
BROWSER_CHANNELS_LIMIT=100
# then restart the API service so it picks up the new value
```

This PC will then pull up to 100 channels on its next 5-min refresh — no
PC-side change needed.

### Cohost (Stream Together) — `COHOST_CHANNELS`

Twitch shows a **combined** viewer badge during cohost / "Stream
Together". The v6 extractor reads each listed channel's **own** slice
from the Shared Viewership popover (or abstains to the server's Helix
data — it never writes the inflated combined). List the channels that
participate in a shared session — the official channel for *co-streaming*,
plus every streamer in a *Stream Together* watch-party:

```powershell
# Append to .env (PowerShell):
Add-Content -Encoding ascii .env "COHOST_CHANNELS=pubg_battlegrounds,kr1stw,pubg_taiwan,pubgjapan,han44fps,jemma009"
```

Solo streams are unaffected (a listed channel streaming alone just
returns its normal badge), so it's safe to leave the roster set
permanently. For the first live broadcast, also add `COHOST_DEBUG=1` and
watch the scraper log for `cohost slice=…` / `cohost extract FAILED …`
lines to confirm the popover selectors resolve before trusting the data.

Verify:

```powershell
Get-Content .env | Select-String '^(RELAY_URL|RELAY_SECRET)='
```

Both should print.

## 3. One-time Twitch login

Cookies live in `scripts\twitch-browser-profile\` and persist across
runs. You only do this once (re-run if the scraper later starts logging
`viewer_count: 0` for every channel — Twitch invalidated the session).

```powershell
cd $HOME\clutch-viewership-tracker
npx tsx scripts/twitch-browser-server.ts
```

Chrome launches with the persistent profile. In that Chrome window:

1. Open `https://twitch.tv` and sign in with the Clutch tracker account.
2. Solve any CAPTCHA / SMS challenge.
3. **Don't tick "Remember this device"** — the user-data-dir is already
   persistent, and toggling that flag actually shortens the session.
4. Close with `Ctrl+C` in the PowerShell window. The profile saves.

## 4. Autostart on login (Task Scheduler)

Two scheduled tasks: one for the browser-server, one for the scraper.
Both run when **you** log in (not at boot — the scraper opens a real
Chrome and needs an interactive session for the persistent profile to
behave correctly), restart automatically on crash, and write logs under
`%LOCALAPPDATA%\clutch-relay\`.

### 4a. Logs directory

```powershell
$LogDir = "$env:LOCALAPPDATA\clutch-relay"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
```

### 4b. Register the tasks

```powershell
$Repo  = "$HOME\clutch-viewership-tracker"
$NpxPs = (Get-Command npx.cmd).Source
$LogDir = "$env:LOCALAPPDATA\clutch-relay"

# --- 1. Browser-server (Chrome host) ---
$serverArg = "/c `"cd /d `"$Repo`" && `"$NpxPs`" tsx scripts\twitch-browser-server.ts >> `"$LogDir\twitch-browser-server.log`" 2>&1`""
$serverAct = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $serverArg
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Restart on failure every minute, up to 99 times.
$settings  = New-ScheduledTaskSettingsSet `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -RestartCount 99 `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0)  # 0 = no limit

Register-ScheduledTask -TaskName "ClutchTwitchBrowserServer" `
    -Action $serverAct -Trigger $trigger -Settings $settings `
    -Description "Persistent Chrome for the Clutch Twitch scraper (CDP 9224)" `
    -Force

# --- 2. Scraper ---
# Delay 30 s so the browser-server has CDP up before the scraper connects.
$scrapeArg = "/c `"timeout /t 30 /nobreak > NUL && cd /d `"$Repo`" && `"$NpxPs`" tsx scripts\twitch-browser-scraper.ts --loop >> `"$LogDir\twitch-browser-scraper.log`" 2>&1`""
$scrapeAct = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $scrapeArg

Register-ScheduledTask -TaskName "ClutchTwitchScraper" `
    -Action $scrapeAct -Trigger $trigger -Settings $settings `
    -Description "Polls Twitch viewer counts and relays to tracker.clutch.game" `
    -Force
```

### 4c. Start them now (without logging out)

```powershell
Start-ScheduledTask -TaskName "ClutchTwitchBrowserServer"
# Wait ~30 s for Chrome to come up, then:
Start-ScheduledTask -TaskName "ClutchTwitchScraper"
```

### 4d. Verify

```powershell
Get-ScheduledTask -TaskName "ClutchTwitch*" |
  Get-ScheduledTaskInfo |
  Select-Object TaskName, LastRunTime, LastTaskResult, NumberOfMissedRuns

Get-Content "$env:LOCALAPPDATA\clutch-relay\twitch-browser-scraper.log" -Tail 30 -Wait
```

After ~30 s the scraper log should print:

```
Twitch Browser Scraper → https://tracker.clutch.game
Connected to Chrome at ws://localhost:9224/...
Polling N channel(s): ...
✓ Relayed N viewer counts
```

If you see `ECONNREFUSED 127.0.0.1:9224` for more than ~45 s, the
browser-server didn't come up — check
`$env:LOCALAPPDATA\clutch-relay\twitch-browser-server.log`.

From the dashboard side, open `https://tracker.clutch.game/` during a
broadcast and look for `last poll · 12s ago` on Twitch channels — the
channel popover's "browser scraper" tag confirms the path that won the
most recent minute.

## 5. Cut the Mac off Twitch

Once the PC is producing fresh polls, disable the Twitch services on
the Mac so it focuses on TikTok:

```bash
# On the Mac (NOT the PC)
launchctl unload ~/Library/LaunchAgents/com.clutch.twitch-browser-scraper.plist
launchctl unload ~/Library/LaunchAgents/com.clutch.twitch-browser-server.plist

# Confirm both are gone:
launchctl list | grep clutch.twitch
# (should print nothing)
```

The TikTok plists (`com.clutch.tiktok-relay`, `com.clutch.tiktok-ws-tracker`)
stay loaded — they're untouched by this change.

## 6. Updating later

When backend or relay-script changes ship to `main`:

```powershell
cd $HOME\clutch-viewership-tracker
git pull origin main
npm install   # only if package.json changed

# Restart both tasks (Task Scheduler will bring them back automatically):
Stop-ScheduledTask  -TaskName "ClutchTwitchScraper"
Stop-ScheduledTask  -TaskName "ClutchTwitchBrowserServer"
Start-ScheduledTask -TaskName "ClutchTwitchBrowserServer"
Start-Sleep -Seconds 30
Start-ScheduledTask -TaskName "ClutchTwitchScraper"
```

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Scraper log: `Chrome not found. Install Google Chrome.` | Chrome installed somewhere non-standard, or only the user-AppData copy exists | Set `chrome.exe` on PATH, or symlink it to `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| Scraper log: `ECONNREFUSED 127.0.0.1:9224` | Browser-server didn't start | `Get-Content $env:LOCALAPPDATA\clutch-relay\twitch-browser-server.log -Tail 30`; common causes: Chrome already running with a different `--user-data-dir`, or another process bound 9224 |
| All channels read `viewer_count: 0` | Twitch logged out | Re-run §3 one-time login |
| Tasks show `LastTaskResult` `267011` (`0x40010`) | Task didn't start because user not logged in | "At Logon" trigger needs an interactive session — log in once and they pick up |
| Scraper polls forever but server doesn't see new data | `RELAY_SECRET` mismatch | Check the log for `401 Unauthorized`; re-copy `RELAY_SECRET` from Mac |
| Chrome window keeps stealing focus on login | Browser-server runs Chrome visibly by design (so you can re-login) | Move Chrome to a different virtual desktop / minimize; cookies persist regardless |
| Want to reclaim a CPU core during gaming sessions | Pause both tasks | `Disable-ScheduledTask -TaskName "ClutchTwitch*"; Stop-Process -Name chrome -ErrorAction SilentlyContinue` — re-enable with `Enable-ScheduledTask` |

## What changes vs the Mac

- **OS orchestration**: Task Scheduler instead of `launchd` / plists.
- **Chrome path**: Windows installer locations instead of
  `/Applications/...`. Handled by `findChrome()` automatically.
- **Logs**: `%LOCALAPPDATA%\clutch-relay\` instead of `/tmp/`.
- **No `MAX_CHANNELS` cap** — the PC can handle the full server list.
- **Same `.env` shape**: `RELAY_URL` + `RELAY_SECRET`, identical values.
- **Same scraper code**: it auto-fetches the active channel list from
  `/api/relay/twitch/browser-channels`, so adding/removing channels in
  the dashboard "just works" with no PC-side change.
