# UX/IA Overhaul — Clutch Viewership Tracker Dashboard

> On execution start: copy this plan to `docs/plans/2026-06-10-ux-overhaul.md` in the backend repo (user convention for long-form plans).

## Context

The dashboard grew feature-by-feature and the seams show. User-reported pains:
1. **Public live dashboard** (`/public/:shortName`) only reachable via the Export dialog.
2. **Discover** only reachable via a StartPage button that does `window.location.href` (hard reload).
3. **StartPage** after login is lackluster (greeting + 3 stats + series grid).
4. **Explore** effectively URL-only / buried inside a series.
5. **Settings scattered**: `/users`, `/settings/youtube-keys`, `/settings/notifications` as ad-hoc buttons; per-series settings at `/:seriesId/edit`; two coexisting shells (legacy Header+Sidebar vs per-page top bars — 5 different top bars total).
6. **Explore page**: flat wall of 30–50 language filter chips; stacked filter rows.
7. **Discover pages**: Trends "Breakdown" shows **0.0% everywhere** (real bug), plus assorted polish debt.

Decisions made with user: **persistent top nav** (not sidebar), **full overhaul**, phased so each phase ships alone.

**Repos:** FE = `clutch-viewership-tracker-redesign/src/dashboard/src` (branch `redesign/claude-design`; deploy `npx vite build` + rsync `dist/`). BE = `clutch-viewership-tracker/src` (branch `main`; deploy git push + server `update.sh`). Both checkouts are the same git repo on different branches — backend edits go ONLY in the main checkout.

**Verified key facts:**
- `FE/App.tsx` bottom block (~line 490+) still renders legacy `MainLayout+Header+Sidebar` as fallback chrome for Users/YT-Keys/Notifications/SeriesSetup/SeriesEdit/StartPage paths.
- The 0.0% bug (confirmed by reading both sides): BE `models/game-tracker-snapshot.ts` `languageBreakdown()` (~line 230) and `platformBreakdown()` (~line 441) return knex `.sum()` rows where PG numerics arrive as **strings** (hidden by `as unknown as` casts); FE `pages/discover/DiscoverTrendsTab.tsx` (~line 488) does `reduce((sum,p)=>sum+p.total_ccv_minutes,0)` → string concat → shares ≈ 1e-4 → "0.0%". Other model fns (`rangeLeaderboard` etc.) already `Number()`-map — these two were missed.
- `GET /api/polling/status` has only counts; no "which series are live" endpoint exists → P4 needs a thin new one. Per-series CCV exists: `GET /api/viewership/live/:seriesId` (5s cache).
- Design system to reuse: `Section, Row, Col, Kpi, HeroKPIs, Pill, TierBadge, Tab, SortHeader, PlatformPip, ChannelNameWithLink, InteractiveMainChart, ScopeScrubber, SettingsShell, ThemeToggle, icons` (all in `FE/components/design/`).

---

## Phase 0 (hotfix, ship immediately): Discover breakdown 0.0% fix
- BE `models/game-tracker-snapshot.ts`: `platformBreakdown()` + `languageBreakdown()` — await query, map rows with `Number()` (same pattern as `rangeLeaderboard` lines ~219–227), drop the `as unknown as` casts.
- FE `pages/discover/DiscoverTrendsTab.tsx`: defensive `Number(p.total_ccv_minutes)` in both `reduce`s and row `value`/`share` mappings (renders correctly even against a stale backend).
- Deploy backend first, then frontend.

## Phase 1: App shell — one TopNav everywhere, retire legacy chrome
**New:** `FE/components/nav/TopNav.tsx` (props: `seriesList, activeSeriesId, pollingStatus, wsStatus?, contextSlot?, actionsSlot?`), `FE/components/nav/SeriesSwitcher.tsx` (grouped dropdown w/ live dots), `FE/components/nav/NavSheet.tsx` (mobile <900px hamburger sheet), barrel.
Tabs: Home `/` · Live `/:activeSeriesId` (fallback `ct-last-series` localStorage → first active series; hidden if none) · Explore `/explore[/:id]` (hidden for viewers) · Discover `/discover` · Settings `/settings`. Plus SeriesSwitcher, orchestrator LIVE pill, WS dot (editor context only), ThemeToggle, user menu.
**Modify:**
- `FE/App.tsx`: mount `<TopNav/>` once in `AppContent`; delete the legacy `MainLayout/Header/Sidebar` fallback block; Users/YT-Keys/Notifications/New/Edit render in their own shells (loading flash → `Spinner`); remove dead imports.
- `FE/pages/StartPage.tsx`: delete inline header (lines ~114–312), drop `window.location.href` Discover button + settings-button props.
- `FE/pages/ExplorePage.tsx`: `ExploreShell` loses its logo/theme/account bar → thin content wrapper.
- `FE/components/design/SettingsShell.tsx`: de-duplicate its own top bar (full rework P3).
- `FE/pages/EditorDesktop.tsx`: strip logo/theme/account from in-main header (~lines 708–879); keep scope breadcrumb + Export; TopNav `contextSlot` = series › day + live pill. Heights via global CSS var `--topnav-h`.
- `FE/pages/EditorMobile.tsx`: delete its sticky header (~lines 248–390); TopNav compact replaces it; bottom tab bar (Live/Channels/Discovery/Ops) untouched.
- Discover pages: remove inline ThemeToggle rows; `DiscoverDetailPage` sticky tabs `top: var(--topnav-h)`.
- Delete after import-grep: `components/layout/Header.tsx`, `MainLayout.tsx`, `Sidebar.tsx` (legacy), orphaned `pages/DashboardPage.tsx`, `SeriesSetupPage.tsx`, `SeriesEditPage.tsx` (verify truly unreferenced first; editor's real ops sidebar lives inside EditorDesktop/EditorMobile).
- All nav SPA (`navigate`/`<Link>`); zero hard reloads.

## Phase 2: Public-link access (one-click everywhere)
**New:** `FE/components/design/PublicLinkButton.tsx` (`variant: button|icon|menu-item`, `canEdit`). Public+short_name → split menu: **Open live dashboard** / **Copy link** / Detailed report / Simple report (URL builder extracted as `publicUrls(series)` helper, mirroring `ExportDialog.tsx` lines ~478–480). Not public → dimmed, menu explains + (editors) "Enable in Series settings →" (`/:id/edit?focus=public`).
**Place in:** EditorDesktop header (replaces the blind "Share" button at ~764–786 that today copies broken `/public/<uuid>` URLs for non-public series — behavior change, call out), EditorMobile sheet, StartPage series cards (replace passive PUBLIC tag; stopPropagation), SeriesForm public section (live open/copy after save + honor `?focus=public` scroll/highlight). No backend changes.

## Phase 3: Settings hub `/settings`
**New:** `FE/pages/SettingsHomePage.tsx` — role-gated cards: Users (admin), YouTube keys (admin), Notifications (editor+), and a "Series settings" explainer card with a series picker → `/:id/edit`.
**Modify:** `SettingsShell` gains side-nav (`nav` prop; shared `SETTINGS_NAV` filtered by role; ≥900px left rail, <900px pill row). Routes: add `/settings`, `/settings/users` (canonical); `/users` → `<Navigate replace>` redirect. Keep `/settings/youtube-keys`, `/settings/notifications`. Editor surfaces get an explicit "Series settings" item. TopNav Settings tab → `/settings`. No backend changes.

## Phase 4: StartPage upgrade
**BE (deploy first):** `api/routes/series.ts` new `GET /api/series/live-now` (registered BEFORE `/:id`): broadcast_days with `status='live'` joined to series, filtered by `min_role` + game-tracker-stub exclusion like `GET /api/series`; returns `[{series:{id,name,short_name,is_public,game,partner}, day:{id,label,date,...}}]`. CCV not aggregated server-side — client composes with existing `GET /api/viewership/live/:seriesId`.
**FE:** `services/api.ts` `getLiveNow()`; new `pages/home/LiveNowStrip.tsx` (poll 15s; per live series: name, day label, live dot, ticking total CCV via `getLiveCCV`, channel count, Open editor + PublicLinkButton; quiet one-line empty state; hide entirely on 404) and `pages/home/QuickNavCards.tsx` (Explore editor+, Discover, small Settings link). Restructure `StartPage.tsx`: greeting (+admin-gate the "New series" CTA — today shown to all roles while the API is admin-only) → LiveNowStrip → QuickNav → existing stats strip → filter pills + search + series grid (cards restyled, P2 icon). "Recently updated" list from `seriesList.updated_at` (top 5).

## Phase 5: Explore page cleanup
**New:** `FE/components/design/FilterMultiSelect.tsx` — compact trigger (`Language · 3 ▾`), popover with search + checkbox list + counts + Clear/Only; Esc/click-outside (reuse SettingsShell menuRef pattern).
**Modify `ExplorePage.tsx` filter region (~lines 801–908):** platforms + categories stay chips; **languages always FilterMultiSelect**; regions chips when ≤8 else multiselect. Single toolbar row + second row of removable active-filter chips. Same URL params written via existing `updateUrl` (`platforms,languages,tiers,regions,q` — `stage,day,channels,at,from,to` untouched) → shared links keep working. Move "Click a row to graph it" hint into the table header sub-line. Frontend-only.

## Phase 6: Discover polish (rest)
- **BE (optional, with P6 deploy):** `countRangeLeaderboard()` (COUNT over the same streamer-grouped subquery) + `total` in `GET /:slug/range-leaderboard` response.
- **FE:** extract `components/design/AccentKpi.tsx` (the thrice-copied red-top-bar KPI card: DiscoverDetailPage `KpiCard`, TrendsTab `TrendKpi`, ChannelPage tiles); move `LeaderboardTable`/`Avatar`/`LeaderboardRow` out of DiscoverDetailPage into `pages/discover/LeaderboardTable.tsx` (ChannelsTab + TrendsTab import from the page today); CSS `:hover` class instead of inline mouse handlers; DiscoverListPage loading skeleton; ChannelsTab pagination "Page X of Y" when `total` present (fallback to current heuristic); dedupe local Pill with design-kit Pill; sticky-offset audit under TopNav.

---

## Risks
1. **Public routes untouched**: TopNav mounts only inside `AppContent` — never in `PublicPage`/`PublicMobile`/`ReportPage`/`PublicLayout`.
2. Route shadowing vs `/:seriesId` catch-all: v6 static-over-dynamic ranking covers `/settings*`; test bogus + real series ids; keep `/users` redirect.
3. Sticky offsets: everything that used `top:0` must use `--topnav-h`.
4. Preserve localStorage keys (`clutch-tracker-theme` + migration, `ct-rail-left/right`, CollapsibleSection keys); new keys `ct-` namespaced.
5. Preserve URL params (Explore + Discover `tab`/`q`) — they're shared links.
6. P2 changes Share semantics (no more uuid fallback links) — announce.
7. Deploy ordering: backend pieces (P0, P4, P6) ship before their frontend; frontend degrades gracefully (Number() guard; LiveNowStrip hides on 404).
8. Keep ops handler props intact through App.tsx refactor (`onStartPolling`, `onTriggerDiscovery`, …) or the editor ops sidebar breaks.
9. Backend edits only in the main checkout (same repo, two branches — avoid drift under `src/api`/`src/models`).

## Verification (gate per phase)
Every phase: `npx tsc --noEmit && npx vite build` clean from `src/dashboard`, then deploy + spot-check.
- **P0**: `curl '<host>/api/game-trackers/goals/breakdown?from=…&to=…'` — `total_ccv_minutes` unquoted numbers; Trends Breakdown shows shares summing ≈100% (GOALS + PUBG trackers).
- **P1**: route walk `/`, `/:seriesId` (desktop + 390px), `/:seriesId/edit`, `/new`, `/explore/:id?stage=…`, `/discover/:slug?tab=trends`, settings pages, logged-out `/public/:shortName` + both report variants (no TopNav); devtools: no document re-fetch on nav clicks; EditorMobile bottom tabs + Ops still work; theme persists.
- **P2**: public series → open/copy/report links exact; non-public → disabled + settings CTA lands on `?focus=public`; `is_public` w/o short_name treated not-ready; card click still opens editor.
- **P3**: `/settings` role-correct (admin vs editor); `/users` redirects (replace); deep links highlight side-nav; viewer direct-hit gets access-denied; API still 403s.
- **P4**: with a live day → strip ticks CCV matching editor Live; none → quiet line; old backend → strip absent, no console errors; viewer doesn't see min_role-restricted series.
- **P5**: long filter URL pre-selects all controls; toggling writes identical params; Reset clears; popover search with 40+ langs; totals footer unchanged.
- **P6**: Page X of Y vs `total`; skeleton on throttled load; hover via CSS; charts unaffected.

## Sequencing
P0 hotfix now → P1 (largest) → P2 (half-day) → P3 (small) → P4 (medium, BE+FE) → P5 (medium) → P6 (medium). Each phase: build, deploy frontend (rsync), backend phases push+update.sh first.
