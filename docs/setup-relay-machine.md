# Relay-Machine Setup

Setup guide for the dedicated machine that runs the residential-IP
relay scrapers (TikTok + Twitch). Picks up where the existing TikTok
HTTP relay is already running and adds the other trackers to it.

## Current state on your relay machine

You already have:

| Tracker | Script | How |
|---|---|---|
| TikTok HTTP relay | `tiktok-relay.ts --loop` | launchd `com.clutch.tiktok-relay` |

You're adding:

| Tracker | Script | Why |
|---|---|---|
| Twitch browser scraper | `twitch-browser-server.ts` + `twitch-browser-scraper.ts --loop` | Reads the Twitch DOM viewer count every 60 s. More granular than the stepped 3–5 min Helix API cache, and the only Twitch path we currently rely on. |
| TikTok browser tracker (optional) | `tiktok-browser-server.ts` + `tiktok-browser-tracker.ts --loop` | Second TikTok signal that opens pages in real Chrome and sniffs the WS. Kicks in if `tiktok-live-connector` gets rate-limited. |
| TikTok WS tracker (optional) | `tiktok-ws-tracker.ts --loop` | Pure-Node direct WebSocket connection per channel. Real-time push events on top of the 60 s poll. |

The server keeps `MAX(value)` per channel per minute across every
relay source, so adding more is purely additive.

> ⚠️ **`scripts/twitch-relay.ts` is deprecated** — that script polled
> Twitch Helix from a remote POP. We've stopped relying on it; the
> browser scraper on port 9224 below is the only Twitch path now.
> The file is still in the repo as a reference, but don't wire it into
> launchd.

## 0. Sanity-check the existing TikTok relay

Before adding anything else, confirm what's there is healthy:

```bash
# On the relay machine
launchctl list | grep clutch.tiktok-relay
# → expect "<pid>   0   com.clutch.tiktok-relay"  (non-zero PID)

tail -n 30 /tmp/tiktok-relay.log
# Expect periodic "Polling 3 TikTok channel(s)..." +
# "✓ Relayed N viewer counts" lines.
```

If that's all good, proceed.

## 1. Pull the latest scripts + deps

The Twitch browser scraper has had a couple of small fixes since you
last cloned. Sync first:

```bash
cd ~/clutch-viewership-tracker
git pull origin main
npm install        # only re-runs if package.json changed
```

## 2. Confirm `.env` covers the new relays

The Twitch browser scraper uses the same `RELAY_URL` + `RELAY_SECRET`
the TikTok relay already has. No new env vars needed.

```bash
grep -E '^(RELAY_URL|RELAY_SECRET)=' ~/clutch-viewership-tracker/.env
# Both should be set. RELAY_URL=https://tracker.clutch.game
```

## 3. Twitch browser scraper

Two pieces: a long-lived **browser-server** (real Chrome with persistent
profile, listening on CDP port 9224) and the **scraper** that connects
to it via CDP and reads viewer counts every 60 s. Both want
`KeepAlive=true` so they survive crashes / reboots.

### 3a. One-time Twitch login

Cookies for the persistent Chrome profile only need to be set up once.

```bash
cd ~/clutch-viewership-tracker
npx tsx scripts/twitch-browser-server.ts
```

That launches Chrome with `--user-data-dir=scripts/twitch-browser-profile`
and `--remote-debugging-port=9224`. In that Chrome window:

1. Open `https://twitch.tv` → sign in with the Clutch tracker account
2. Solve any CAPTCHA / SMS challenge Twitch presents
3. **Don't tick "Remember this device"** — the user-data-dir is already
   persistent, so toggling that flag actually shortens cookie lifetime
4. Close the script with `Ctrl+C`. The profile saves on exit.

Cookies last ~30 days. Re-run this step if the scraper log starts
showing `viewer_count: 0` for every channel — that's usually Twitch
having logged the profile out.

### 3b. launchd plists

Drop the two plists. They use `$HOME` so they're portable across
usernames as long as the repo is at `~/clutch-viewership-tracker`.

```bash
USER_HOME=$HOME

cat > ~/Library/LaunchAgents/com.clutch.twitch-browser-server.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.clutch.twitch-browser-server</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/npx</string>
        <string>tsx</string>
        <string>${USER_HOME}/clutch-viewership-tracker/scripts/twitch-browser-server.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${USER_HOME}/clutch-viewership-tracker</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/twitch-browser-server.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/twitch-browser-server.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${USER_HOME}</string>
    </dict>
</dict>
</plist>
EOF

cat > ~/Library/LaunchAgents/com.clutch.twitch-browser-scraper.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.clutch.twitch-browser-scraper</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/npx</string>
        <string>tsx</string>
        <string>${USER_HOME}/clutch-viewership-tracker/scripts/twitch-browser-scraper.ts</string>
        <string>--loop</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${USER_HOME}/clutch-viewership-tracker</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <!-- 20 s grace so the browser-server has CDP up before scraper connects -->
    <key>ThrottleInterval</key>
    <integer>20</integer>
    <key>StandardOutPath</key>
    <string>/tmp/twitch-browser-scraper.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/twitch-browser-scraper.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${USER_HOME}</string>
    </dict>
</dict>
</plist>
EOF

launchctl load -w ~/Library/LaunchAgents/com.clutch.twitch-browser-server.plist
launchctl load -w ~/Library/LaunchAgents/com.clutch.twitch-browser-scraper.plist
```

The scraper auto-fetches the active Twitch channel list from
`/api/relay/twitch/browser-channels`, so adding/removing channels in
the dashboard just works — no plist edit needed.

### 3c. Verify

```bash
launchctl list | grep clutch.twitch
# Both should show non-zero PIDs:
#   <pid>  0  com.clutch.twitch-browser-server
#   <pid>  0  com.clutch.twitch-browser-scraper

tail -f /tmp/twitch-browser-scraper.log
# After the 20 s ThrottleInterval, expect:
#   Twitch Browser Scraper → https://tracker.clutch.game
#   Connected to Chrome at ws://localhost:9224/...
#   Polling N channel(s): ...
#   ✓ Relayed N viewer counts
```

If the scraper log shows `ECONNREFUSED 127.0.0.1:9224` for more than a
minute, the browser-server didn't come up — `tail /tmp/twitch-browser-server.err`.

## 4. (Optional) TikTok browser tracker

A second TikTok signal: opens TikTok pages in a real Chrome and
intercepts the WebSocket. Useful when `tiktok-live-connector` (the
HTTP relay you're already running) gets rate-limited on a specific
channel — the browser path uses real session cookies and rarely hits
the same wall.

### 4a. One-time TikTok login

```bash
cd ~/clutch-viewership-tracker
npx tsx scripts/tiktok-browser-server.ts
```

Sign into `https://tiktok.com` in the Chrome window that opens,
solve any CAPTCHA, then `Ctrl+C`.

The TikTok browser-server uses CDP port **9222** (different from
Twitch's 9224, so they coexist).

### 4b. launchd plists

```bash
USER_HOME=$HOME

cat > ~/Library/LaunchAgents/com.clutch.tiktok-browser-server.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.clutch.tiktok-browser-server</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/npx</string>
        <string>tsx</string>
        <string>${USER_HOME}/clutch-viewership-tracker/scripts/tiktok-browser-server.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${USER_HOME}/clutch-viewership-tracker</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/tiktok-browser-server.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/tiktok-browser-server.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${USER_HOME}</string>
    </dict>
</dict>
</plist>
EOF

cat > ~/Library/LaunchAgents/com.clutch.tiktok-browser-tracker.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.clutch.tiktok-browser-tracker</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/npx</string>
        <string>tsx</string>
        <string>${USER_HOME}/clutch-viewership-tracker/scripts/tiktok-browser-tracker.ts</string>
        <string>--loop</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${USER_HOME}/clutch-viewership-tracker</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>20</integer>
    <key>StandardOutPath</key>
    <string>/tmp/tiktok-browser-tracker.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/tiktok-browser-tracker.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${USER_HOME}</string>
    </dict>
</dict>
</plist>
EOF

launchctl load -w ~/Library/LaunchAgents/com.clutch.tiktok-browser-server.plist
launchctl load -w ~/Library/LaunchAgents/com.clutch.tiktok-browser-tracker.plist
```

## 5. (Optional) TikTok WebSocket tracker

Pure Node WebSocket connection per channel, no Chrome involved. Adds
real-time push events on top of the 60 s HTTP poll.

```bash
USER_HOME=$HOME

cat > ~/Library/LaunchAgents/com.clutch.tiktok-ws-tracker.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.clutch.tiktok-ws-tracker</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/npx</string>
        <string>tsx</string>
        <string>${USER_HOME}/clutch-viewership-tracker/scripts/tiktok-ws-tracker.ts</string>
        <string>--loop</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${USER_HOME}/clutch-viewership-tracker</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/tiktok-ws-tracker.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/tiktok-ws-tracker.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${USER_HOME}</string>
    </dict>
</dict>
</plist>
EOF

launchctl load -w ~/Library/LaunchAgents/com.clutch.tiktok-ws-tracker.plist
```

## 6. End-to-end verification

After all the relays you want are loaded:

```bash
launchctl list | grep ^[0-9].*clutch
# Each Label you loaded should show a non-zero PID + 0 exit status.
```

From the dashboard side, open `https://tracker.clutch.game/` during an
active broadcast and look for fresh `last poll · 12s ago` indicators
on the channels you'd expect this machine to be feeding.

For Twitch specifically, the redesign has a "browser scraper" tag in
the channel popover so you can see at a glance whether the browser
path or the API path won the most recent minute.

## 7. Updating later

When backend or relay-script changes ship to `main`:

```bash
cd ~/clutch-viewership-tracker
git pull origin main
npm install   # only if package.json changed

# Restart everything in one go (safe — KeepAlive will bring them back):
ls ~/Library/LaunchAgents/com.clutch.*.plist | while read p; do
  launchctl unload "$p"
  launchctl load -w "$p"
done
```

Or restart a single one without touching the rest:

```bash
launchctl kickstart -k gui/$UID/com.clutch.twitch-browser-scraper
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `tiktok-relay.log` shows `401 Unauthorized` | `RELAY_SECRET` mismatch with server | Re-copy from primary `.env` or rotate on server |
| `twitch-browser-scraper.log` shows `ECONNREFUSED 127.0.0.1:9224` | `twitch-browser-server` died | `tail /tmp/twitch-browser-server.err`; restart with `launchctl kickstart` |
| Twitch viewer counts all read `0` | Profile got logged out of Twitch | Re-run §3a one-time login |
| `launchctl load` says `Bootstrap failed: 5: I/O error` | Previous load is stuck | `launchctl unload` first, or reboot |
| Dock cluttered with Chrome icons at login | Each browser-server keeps Chrome resident | Intentional — those are the persistent profiles. They use no battery when idle. |
| `ENOENT: tsx not found` | npm didn't install | `cd ~/clutch-viewership-tracker && npm install` |
| Multiple errors after macOS update | Node moved (e.g. Apple silicon → Rosetta) | `which npx` → if not `/opt/homebrew/bin/npx`, edit the plists and reload |

## What changes vs the primary Mac

Only paths and the username. The `.env` is identical (same `RELAY_URL`,
same `RELAY_SECRET`). The `TIKTOK_CHANNELS` list is hardcoded in
`tiktok-relay.ts` so both Macs poll the same three channels — that's
fine, the server dedupes by `MAX` per minute. The Twitch browser
scraper auto-fetches its channel list from the server, so it's
truly zero-config beyond the launchd plist.
