# Plan documents

Durable storage for design / implementation plans. Lives in the repo so it survives Claude Code's plan-mode file overwrites and is version-controlled like any other document.

## Convention

- One file per plan: `YYYY-MM-DD-short-slug.md`
- Date prefix is the day the plan was written (not when it's implemented).
- Slug is short and semantic (`live-game-tracker`, `s3-backup-nightly`, `mobile-export`). Lowercase, hyphenated.
- Plans stay here even after implementation — they're a record of *why* a thing was built that way.

## Why not `~/.claude/plans/`?

Claude Code's own plan files live at `~/.claude/plans/<auto-slug>.md`, which works well for mid-conversation scratch but is fragile for anything we want to keep:

- The slug is auto-generated and reused across sessions, so a new plan can overwrite an older one (this happened to the May 2 PUBG global tracker plan — overwritten on May 3 by a different plan that happened to start with the same trigger phrase).
- The directory is local-machine-only. Not synced, not in version control, not shared with other operators.

`docs/plans/` is the answer to both. Plans for important features should be written here directly (or copied here as soon as they survive the first iteration).

## Index

- [2026-05-05 — Live Game Tracker](2026-05-05-live-game-tracker.md) — continuous tracking of all Twitch / Kick / YouTube streams in a configured game (PUBG: BG, etc.), separate from tournament tracking. Draft, awaiting review.
