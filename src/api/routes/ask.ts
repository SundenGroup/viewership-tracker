/**
 * Ask routes — natural-language questions scoped to what the user is viewing.
 *
 * POST /api/ask/explore/:seriesId  (editor+, mounted with requireRole)
 *   body: { question: string, viewState?: { stage?, day?, channels?,
 *           languages?, platforms?, tiers?, regions? } }
 *
 * Simple questions are answered by a deterministic matcher first — no model
 * call, works with no API key. Otherwise the model picks one intent from a
 * closed catalog; the server validates, resolves ids against this series,
 * and either runs the query (numbers always from Postgres) or returns a
 * URL-state patch. See src/agent/ask/ for the matcher, compiler + Explore
 * surface.
 */

import Anthropic from '@anthropic-ai/sdk';
import { Router, Request, Response, NextFunction } from 'express';
import * as TournamentSeriesModel from '../../models/tournament-series';
import { compileIntent, isAskConfigured, CompiledIntent } from '../../agent/ask/compiler';
import { matchExploreQuestion } from '../../agent/ask/matcher';
import {
  buildExploreTools,
  buildExploreVocabulary,
  executeExploreIntent,
  renderAskContext,
  AskViewState,
} from '../../agent/ask/explore';
import logger from '../../utils/logger';

const router = Router();

const MAX_QUESTION_LENGTH = 300;

// ── In-memory limits ────────────────────────────────────────────────────────
// Deliberately process-local: Ask is editor-only BETA and the tracker runs as
// a single process. 30 questions/user/hour + a global daily ceiling so a
// runaway client can't burn the token budget.

const USER_LIMIT_PER_HOUR = 30;
const GLOBAL_LIMIT_PER_DAY = 500;

const userWindows = new Map<string, number[]>();
let globalDayKey = '';
let globalDayCount = 0;

function checkUserLimit(userId: string): boolean {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const window = (userWindows.get(userId) ?? []).filter((t) => t > cutoff);
  if (window.length >= USER_LIMIT_PER_HOUR) {
    userWindows.set(userId, window);
    return false;
  }
  window.push(now);
  userWindows.set(userId, window);
  return true;
}

function checkGlobalLimit(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== globalDayKey) {
    globalDayKey = today;
    globalDayCount = 0;
  }
  if (globalDayCount >= GLOBAL_LIMIT_PER_DAY) return false;
  globalDayCount += 1;
  return true;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isValidUUID(val: unknown): boolean {
  if (typeof val !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
}

/** Only carry through the string keys the Explore surface understands. */
function sanitizeViewState(raw: unknown): AskViewState {
  if (typeof raw !== 'object' || raw === null) return {};
  const src = raw as Record<string, unknown>;
  const out: AskViewState = {};
  for (const key of ['stage', 'day', 'channels', 'languages', 'platforms', 'tiers', 'regions'] as const) {
    const v = src[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim();
  }
  return out;
}

// ── Routes ──────────────────────────────────────────────────────────────────

// POST /api/ask/explore/:seriesId — one question about the current Explore view
router.post('/explore/:seriesId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const started = Date.now();

    if (!isValidUUID(req.params.seriesId)) {
      res.status(400).json({ error: 'Invalid seriesId format' });
      return;
    }
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    if (!question) {
      res.status(400).json({ error: 'question is required' });
      return;
    }
    if (question.length > MAX_QUESTION_LENGTH) {
      res.status(400).json({ error: `question must be at most ${MAX_QUESTION_LENGTH} characters` });
      return;
    }

    // requireRole guarantees req.user, but keep the fail-closed guard anyway.
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const series = await TournamentSeriesModel.findById(req.params.seriesId as string);
    if (!series) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }

    const viewState = sanitizeViewState(req.body?.viewState);
    const vocab = await buildExploreVocabulary(series);

    // Deterministic fast path — simple questions never touch the model (or
    // the rate limits guarding its token budget), so they keep working even
    // with no API key. The matcher only fires when it fully understands the
    // question; anything ambiguous falls through to the compiler.
    const matched = matchExploreQuestion(question, vocab, viewState);
    if (matched) {
      const envelope = await executeExploreIntent(matched.name, matched.input, {
        series,
        vocab,
        viewState,
      });
      logger.info('[Ask] explore question', {
        user: req.user?.email,
        seriesId: series.id,
        question,
        intent: matched.name,
        kind: envelope.kind,
        source: 'matcher',
        ms: Date.now() - started,
      });
      res.json(envelope);
      return;
    }

    if (!isAskConfigured()) {
      res.status(501).json({ error: 'Ask is not configured' });
      return;
    }
    if (!checkUserLimit(userId)) {
      res.status(429).json({ error: 'Ask limit reached — try again in a bit (30 questions per hour)' });
      return;
    }
    if (!checkGlobalLimit()) {
      logger.warn('[Ask] Global daily budget exhausted', { limit: GLOBAL_LIMIT_PER_DAY });
      res.status(429).json({ error: 'Ask is taking a breather — the daily question budget is used up' });
      return;
    }

    const tools = buildExploreTools(vocab);
    const context = renderAskContext(series, vocab, viewState);

    let compiled: CompiledIntent;
    try {
      compiled = await compileIntent({ tools, context, question });
    } catch (err) {
      // Honest failure — credits exhausted / auth / network to Anthropic.
      if (err instanceof Anthropic.APIError) {
        logger.error('[Ask] Anthropic API error', { status: err.status, message: err.message });
        res.status(502).json({
          error: 'llm_unavailable',
          message: 'The AI backend is unavailable (likely out of API credits). Simple filter questions still work.',
        });
        return;
      }
      throw err;
    }
    const envelope = await executeExploreIntent(compiled.name, compiled.input, {
      series,
      vocab,
      viewState,
    });

    // Audit trail — every question, resolved intent and latency.
    logger.info('[Ask] explore question', {
      user: req.user?.email,
      seriesId: series.id,
      question,
      intent: compiled.name,
      kind: envelope.kind,
      source: 'llm',
      ms: Date.now() - started,
    });

    res.json(envelope);
  } catch (err) {
    next(err);
  }
});

export default router;
