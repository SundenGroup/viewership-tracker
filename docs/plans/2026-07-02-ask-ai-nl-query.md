# Ask AI — natural-language queries for Explore & Discover

*Design synthesis from a 7-agent workflow (1 codebase-grounding, 3 competing
architectures, 3 adversarial red-teams), 2026-07-02. All three approaches
were judged **sound-with-mitigations**; none unsafe-as-designed.*

## The question shape

"Show me the 10 biggest Turkish streamers from May 2026" (→ category-wide,
game-tracker data) and "all Russian-language watch parties for the whole
series" (→ series roster, tier+language filters). An Ask feature must route
between those two data stores silently and answer with numbers that match
the dashboard.

## The three candidate architectures

| | A · Tool-calling over existing API | B · Guarded text-to-SQL | C · Query-plan DSL |
|---|---|---|---|
| How | Claude tool-use loop over ~12 existing endpoints/model fns | Claude writes one SELECT against curated views; AST guard + read-only role | Claude emits validated JSON plan; server compiles via the SAME model functions the UI uses |
| Effort | ~11–13 pd | ~13–15 pd | ~19 pd |
| Latency/cost | 5–20 s, model-dominated, ~$0.01–0.05/q | p50 3–5 s, single generation, cheapest LLM path | template fast-path 150–900 ms & **$0** for 50–70% of questions; LLM path otherwise |
| Expressiveness | bounded by tool shapes | highest (arbitrary SQL) | bounded by DSL; hard ceiling on "why did X dip?" |
| Numbers match dashboard | yes (same code paths) | mostly (views bake in dedup, but avg-of-avg not structurally prevented) | **yes, by construction** |
| Injection surface | tool-result text re-enters model | formatter + denylist fragility | none in compile path (JSON schema) |
| Answer verifiability | deep-links | weak | **plans map 1:1 to Explore/Discover URLs** |

## Recommendation

**Hybrid: C's compiler as the engine, A's loop as the wrapper; defer B.**

1. Claude (tool-loop) does what LLMs are good at: entity/date resolution,
   choosing dataset (series vs tracker), multi-turn refinement ("now only
   Kick").
2. Its only *actuator* is `run_query_plan(plan)` — the validated DSL that
   compiles to the exact aggregation code the dashboard runs. No SQL, no
   free-form endpoint access.
3. Every answer carries **"Open in Explore/Discover"** — the plan IS a URL
   state, so users can verify and keep working interactively. This is the
   trust feature no competitor has.
4. Top ~20 question shapes get template fast-paths (regex/embedding routed):
   sub-second, zero tokens.
5. B (guarded SQL) stays a possible internal/admin escape hatch later, not
   BETA-facing.

## Phases

- **Phase 0 (URGENT, ½ d, independent of Ask):** report-agent.ts pins
  `claude-sonnet-4-20250514`, retired 2026-06-15 — report narratives are
  silently broken in prod today. Bump `@anthropic-ai/sdk`, move to a
  current model id, home `ANTHROPIC_API_KEY` in config.ts.
- **Phase 1 — BETA (editor-only, ~2 wks):** POST /api/ask (SSE streamed),
  tool loop with plan compiler over series + tracker datasets, Ask bar in
  Explore + Discover headers, feedback thumbs + `ask_queries` audit table,
  feature flag + kill switch.
- **Phase 2 (~1 wk):** template fast-path, saved/suggested questions
  ("What can I ask?"), multi-turn context.
- **Phase 3:** partner/public exposure (public series only) after the BETA
  mitigation list is green.

## Non-negotiable mitigations (union of red-team findings)

1. **Prompt injection via data:** `stream_title`/`display_name` are
   attacker-controlled. Wrap all row text as untrusted data in the model
   context; never render model-emitted markdown links — only
   server-validated deep-links (key AND value validation, path allowlist).
2. **Authorization fail-closed:** every compiled plan re-checks
   `min_role`/`is_public` per resolved id (incl. multi_stage id lists);
   entity catalog cached per role, never globally.
3. **DB availability:** dedicated read-only PG role, `statement_timeout`
   2–5 s, LIMIT caps; tracker queries need a rollup or index budget (raw
   `game_tracker_snapshots` month scans are the tail risk on the live
   ingest DB).
4. **Cost control:** atomic per-user daily budget (DB counter, not
   read-then-increment), global daily USD kill switch, max 6 tool turns,
   result-row caps before re-entering model context.
5. **Wrong-answer honesty:** one timezone convention (series tz for series
   scope; stated explicitly in every answer); "biggest" must state its
   metric ("by peak CCV — ask for viewed hours if you meant reach");
   population disclosure ("across the whole PUBG category" vs "within
   PNC2026"); partial-coverage flags.
6. **Pre-req gap found:** `ViewFilter`/`buildFilterClauses` has **no tier
   filtering** — "watch parties only" cannot be filtered server-side today.
   Add `tiers` to the filter layer first (also benefits existing UI).

## Cost envelope

BETA (editor-only, ~50 q/day): template hits $0; LLM path ≈ $0.01–0.05 per
question (Sonnet-class loop, 2–4 tool turns) → **< $50/mo** at BETA scale.
Latency: sub-second on templates, 5–15 s streamed otherwise.
