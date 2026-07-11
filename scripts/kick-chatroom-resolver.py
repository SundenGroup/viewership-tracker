#!/usr/bin/env python3
"""
Kick chatroom-id resolver (SERVER-SIDE).

Kick's chatroom-id endpoint (kick.com/api/v2/channels/{slug} — the only
source of the ids the chat collector needs for its Pusher subscriptions)
is fronted by Cloudflare, which 403s any client whose TLS handshake
doesn't look like a real browser. It is NOT an IP block: with a Chrome
TLS fingerprint (curl_cffi impersonate) the datacenter server gets 200
directly. So this runs on the SERVER — no residential PC, no proxy
required (a proxy is used only if KICK_PROXY_URL is set, as extra
insurance if Kick ever adds IP checks too).

Flow: pull pending Kick slugs from our own relay endpoint (biggest first),
resolve each chatroom id with a Chrome-impersonated request, push the ids
back to be cached in channels.metadata.kick_chatroom_id. The Node chat
collector then subscribes to those chats on its next selection cycle.

Usage (pm2 on the server):
  pm2 start "python3 scripts/kick-chatroom-resolver.py --loop" --name kick-chatroom-resolver

Env (from .env or shell): RELAY_URL, RELAY_SECRET, KICK_PROXY_URL (optional).
Requires: pip install curl_cffi
"""
import os
import sys
import time
from datetime import datetime, timezone
from curl_cffi import requests as creq

# ── Load .env (same shape the Node relays parse) ─────────────────────────
_here = os.path.dirname(os.path.abspath(__file__))
_env = os.path.join(_here, "..", ".env")
if os.path.exists(_env):
    with open(_env) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            v = v.strip().strip('"').strip("'")
            os.environ.setdefault(k.strip(), v)

RELAY_URL = os.environ.get("RELAY_URL", "https://tracker.clutch.game").rstrip("/")
RELAY_SECRET = os.environ.get("RELAY_SECRET", "")
KICK_PROXY_URL = os.environ.get("KICK_PROXY_URL", "").strip()
LOOP = "--loop" in sys.argv[1:]
INTERVAL_S = 10 * 60
IMPERSONATE = "chrome124"
PROXIES = {"http": KICK_PROXY_URL, "https": KICK_PROXY_URL} if KICK_PROXY_URL else None


def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] [KickResolver] {msg}", flush=True)


def get_pending() -> list:
    r = creq.get(
        f"{RELAY_URL}/api/relay/kick/chatroom-pending",
        headers={"Authorization": f"Bearer {RELAY_SECRET}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json().get("slugs", [])


def resolve(slug: str):
    try:
        r = creq.get(
            f"https://kick.com/api/v2/channels/{slug}",
            impersonate=IMPERSONATE,
            proxies=PROXIES,
            timeout=25,
        )
        if r.status_code != 200:
            log(f"  {slug}: HTTP {r.status_code}")
            return None
        cid = (r.json().get("chatroom") or {}).get("id")
        return int(cid) if isinstance(cid, int) and cid > 0 else None
    except Exception as e:  # noqa: BLE001
        log(f"  {slug}: {str(e)[:90]}")
        return None


def push(ids: list) -> int:
    r = creq.post(
        f"{RELAY_URL}/api/relay/kick/chatroom-ids",
        headers={
            "Authorization": f"Bearer {RELAY_SECRET}",
            "Content-Type": "application/json",
        },
        json={"ids": ids},
        timeout=30,
    )
    r.raise_for_status()
    return r.json().get("updatedRows", 0)


def run_once() -> None:
    slugs = get_pending()
    if not slugs:
        log("no pending channels — all chatroom ids cached")
        return
    log(f"{len(slugs)} pending{' (via proxy)' if PROXIES else ' (direct)'}")
    resolved = []
    for slug in slugs:
        cid = resolve(slug)
        if cid is not None:
            resolved.append({"slug": slug, "chatroomId": cid})
        time.sleep(1.2)  # gentle pacing
    if resolved:
        rows = push(resolved)
        log(f"resolved {len(resolved)}/{len(slugs)} → cached onto {rows} channel row(s)")
    else:
        log(f"resolved 0/{len(slugs)}")


def main() -> None:
    if not RELAY_SECRET:
        print("ERROR: RELAY_SECRET not set", file=sys.stderr)
        sys.exit(1)
    log(f"resolver → {RELAY_URL} ({'loop 10m' if LOOP else 'single run'}, {IMPERSONATE})")
    while True:
        try:
            run_once()
        except Exception as e:  # noqa: BLE001
            log(f"ERROR: {str(e)[:140]}")
        if not LOOP:
            break
        time.sleep(INTERVAL_S)


if __name__ == "__main__":
    main()
