/**
 * ExploreAskBox — natural-language "Ask" for the Explore page.
 *
 * A single-line input in the scrubber card ("Ask this view… ⌘K"). The server
 * compiles the question into exactly one validated intent and answers with
 * one of three envelopes:
 *   • patch   — URL-state change; we apply it immediately (the page
 *               re-rendering IS the answer) and show a slim confirmation bar
 *               with Undo, auto-dismissed after 8s.
 *   • answer  — numbers straight from Postgres, rendered as an AnswerCard
 *               (stat blocks / compact table) below the scrubber.
 *   • refusal — muted message + suggestion chips that refill the input.
 *
 * State lives in `useExploreAsk` so the input can sit inside the scrubber
 * card while results render directly under it — two components, one brain.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Row, Col, Pill, IconSparkle, IconX } from '@/components/design';
import { fmtN } from '@/design/format';
import * as api from '@/services/api';
import { ApiError } from '@/services/api';

const AUTO_DISMISS_MS = 8000;

// ── Shared controller ─────────────────────────────────────────────────────

interface PatchConfirmation {
  headline: string;
  chips: string[];
  /** Search-params string captured BEFORE the patch — restored by Undo. */
  snapshot: string;
}

export interface ExploreAskController {
  question: string;
  setQuestion: (q: string) => void;
  pending: boolean;
  error: string | null;
  answer: Extract<api.AskEnvelope, { kind: 'answer' }> | null;
  refusal: Extract<api.AskEnvelope, { kind: 'refusal' }> | null;
  confirmation: PatchConfirmation | null;
  submit: () => void;
  undo: () => void;
  dismiss: () => void;
  applyPatch: (patch: api.AskPatch) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

export function useExploreAsk({
  seriesId,
  getViewState,
  onPatch,
  snapshotParams,
  restoreParams,
}: {
  seriesId: string;
  getViewState: () => api.AskViewState;
  onPatch: (set: Record<string, string>, del: string[]) => void;
  snapshotParams: () => string;
  restoreParams: (params: string) => void;
}): ExploreAskController {
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Extract<api.AskEnvelope, { kind: 'answer' }> | null>(null);
  const [refusal, setRefusal] = useState<Extract<api.AskEnvelope, { kind: 'refusal' }> | null>(null);
  const [confirmation, setConfirmation] = useState<PatchConfirmation | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dismissTimer = useRef<number | null>(null);

  const clearDismissTimer = useCallback(() => {
    if (dismissTimer.current !== null) {
      window.clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
  }, []);
  useEffect(() => clearDismissTimer, [clearDismissTimer]);

  const dismiss = useCallback(() => {
    clearDismissTimer();
    setAnswer(null);
    setRefusal(null);
    setConfirmation(null);
    setError(null);
  }, [clearDismissTimer]);

  const applyPatch = useCallback(
    (patch: api.AskPatch) => onPatch(patch.set, patch.del),
    [onPatch],
  );

  const submit = useCallback(async () => {
    const q = question.trim();
    if (!q || pending) return;
    // Only ONE result at a time — a new question replaces whatever is shown.
    dismiss();
    setPending(true);
    try {
      const envelope = await api.askExplore(seriesId, q, getViewState());
      if (envelope.kind === 'patch') {
        // Capture the pre-patch URL first so Undo can restore it exactly.
        const snapshot = snapshotParams();
        onPatch(envelope.patch.set, envelope.patch.del);
        setConfirmation({ headline: envelope.headline, chips: envelope.resolvedIntent, snapshot });
        dismissTimer.current = window.setTimeout(() => setConfirmation(null), AUTO_DISMISS_MS);
      } else if (envelope.kind === 'answer') {
        setAnswer(envelope);
      } else {
        setRefusal(envelope);
      }
    } catch (e) {
      if (e instanceof ApiError) {
        setError(
          e.status === 429
            ? 'Ask limit reached — try again in a little while.'
            : e.status === 501
              ? 'Ask isn’t configured on this server.'
              : 'Ask hit a snag — try again.',
        );
      } else {
        setError('Ask hit a snag — try again.');
      }
    } finally {
      setPending(false);
    }
  }, [question, pending, seriesId, getViewState, onPatch, snapshotParams, dismiss]);

  const undo = useCallback(() => {
    if (!confirmation) return;
    clearDismissTimer();
    restoreParams(confirmation.snapshot);
    setConfirmation(null);
  }, [confirmation, restoreParams, clearDismissTimer]);

  return {
    question,
    setQuestion,
    pending,
    error,
    answer,
    refusal,
    confirmation,
    submit: () => void submit(),
    undo,
    dismiss,
    applyPatch,
    inputRef,
  };
}

// ── Input (lives inside the scrubber card) ────────────────────────────────

export function ExploreAskBox({ ask }: { ask: ExploreAskController }) {
  // Global ⌘K / Ctrl+K focuses the box — unless the user is typing elsewhere.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.key === 'k' || e.key === 'K') || !(e.metaKey || e.ctrlKey)) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const typingElsewhere =
        target !== ask.inputRef.current &&
        (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable);
      if (typingElsewhere) return;
      e.preventDefault();
      ask.inputRef.current?.focus();
      ask.inputRef.current?.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ask.inputRef]);

  return (
    <div style={{ flex: 1, maxWidth: 460, minWidth: 220 }}>
      <Row
        gap={7}
        align="center"
        style={{
          padding: '5px 10px',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 7,
          opacity: ask.pending ? 0.75 : 1,
        }}
      >
        <IconSparkle size={12} style={{ color: 'var(--fg-dim)', flexShrink: 0 }} />
        <input
          ref={ask.inputRef}
          value={ask.question}
          disabled={ask.pending}
          onChange={(e) => ask.setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') ask.submit();
            if (e.key === 'Escape') (e.currentTarget as HTMLInputElement).blur();
          }}
          placeholder={'Ask this view — e.g. "show Russian watch parties"  ⌘K'}
          aria-label="Ask this view"
          style={{
            flex: 1,
            minWidth: 0,
            border: 0,
            outline: 'none',
            background: 'transparent',
            color: 'var(--fg)',
            fontSize: 12,
          }}
        />
        {ask.pending && <PendingDots />}
      </Row>
      {ask.error && (
        <div style={{ fontSize: 10.5, color: 'var(--fg-dim)', marginTop: 3, paddingLeft: 2 }}>
          {ask.error}
        </div>
      )}
    </div>
  );
}

/** Inline three-dot shimmer shown while a question is compiling. */
function PendingDots() {
  return (
    <span style={{ display: 'inline-flex', gap: 3, flexShrink: 0 }} aria-label="Thinking…">
      <style>{`@keyframes askDotPulse { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }`}</style>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 4,
            height: 4,
            borderRadius: '50%',
            background: 'var(--fg-muted)',
            animation: `askDotPulse 1.1s ease-in-out ${i * 0.18}s infinite`,
          }}
        />
      ))}
    </span>
  );
}

// ── Results (render directly under the scrubber card) ────────────────────

export function ExploreAskResults({ ask }: { ask: ExploreAskController }) {
  if (ask.confirmation) {
    return (
      <div
        style={{
          padding: '7px 14px',
          background: 'color-mix(in oklab, var(--live) 7%, var(--bg-card))',
          border: '1px solid color-mix(in oklab, var(--live) 25%, transparent)',
          borderRadius: 8,
        }}
      >
        <Row gap={8} align="center" style={{ flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--live)', fontSize: 12, fontWeight: 600 }}>
            ✓ {ask.confirmation.headline}
          </span>
          <Row gap={4} align="center" style={{ flexWrap: 'wrap' }}>
            {ask.confirmation.chips.map((chip, i) => (
              <Pill key={`${chip}-${i}`}>{chip}</Pill>
            ))}
          </Row>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={ask.undo}
            style={{
              background: 'transparent',
              border: 0,
              color: 'var(--fg-muted)',
              cursor: 'pointer',
              fontSize: 11.5,
              textDecoration: 'underline',
              padding: 0,
            }}
          >
            Undo
          </button>
        </Row>
      </div>
    );
  }

  if (ask.refusal) {
    return (
      <div className="card" style={{ padding: '12px 16px' }}>
        <Row justify="space-between" align="center" style={{ gap: 10 }}>
          <span style={{ fontSize: 12.5, color: 'var(--fg-muted)' }}>{ask.refusal.message}</span>
          <CloseButton onClick={ask.dismiss} />
        </Row>
        {ask.refusal.suggestions.length > 0 && (
          <Row gap={6} style={{ marginTop: 9, flexWrap: 'wrap' }}>
            {ask.refusal.suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  ask.setQuestion(s);
                  ask.inputRef.current?.focus();
                }}
                style={{
                  padding: '4px 10px',
                  borderRadius: 999,
                  fontSize: 11,
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  color: 'var(--fg-muted)',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {s}
              </button>
            ))}
          </Row>
        )}
        <AskFooter chips={ask.refusal.resolvedIntent} />
      </div>
    );
  }

  if (ask.answer) {
    return (
      <div className="card" style={{ padding: '14px 16px' }}>
        <Row justify="space-between" align="center" style={{ gap: 10, marginBottom: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{ask.answer.headline}</span>
          <CloseButton onClick={ask.dismiss} />
        </Row>
        {ask.answer.blocks.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--fg-dim)' }}>
            No data matched in this scope.
          </div>
        )}
        <Row gap={32} style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {ask.answer.blocks
            .filter((b): b is Extract<api.AskBlock, { type: 'stat' }> => b.type === 'stat')
            .map((b) => (
              <Col key={b.label} gap={2}>
                <span className="eyebrow" style={{ fontSize: 9.5 }}>
                  {b.label}
                </span>
                <span className="tabular" style={{ fontSize: 26, fontWeight: 600, lineHeight: 1.1 }}>
                  {fmtN(b.value)}
                </span>
                {b.sub && (
                  <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{b.sub}</span>
                )}
              </Col>
            ))}
        </Row>
        {ask.answer.blocks
          .filter((b): b is Extract<api.AskBlock, { type: 'table' }> => b.type === 'table')
          .map((b, i) => (
            <AskTable key={i} columns={b.columns} rows={b.rows} />
          ))}
        <AskFooter
          chips={ask.answer.resolvedIntent}
          action={
            ask.answer.patchSuggestion ? (
              <button
                type="button"
                className="btn btn-xs"
                onClick={() => {
                  ask.applyPatch(ask.answer!.patchSuggestion!);
                  ask.dismiss();
                }}
              >
                Apply as filters →
              </button>
            ) : undefined
          }
        />
      </div>
    );
  }

  return null;
}

// ── Card internals ─────────────────────────────────────────────────────────

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Dismiss"
      style={{
        background: 'transparent',
        border: 0,
        color: 'var(--fg-dim)',
        cursor: 'pointer',
        padding: 2,
        display: 'inline-flex',
        flexShrink: 0,
      }}
    >
      <IconX size={13} />
    </button>
  );
}

/** Compact result table — mono numbers right-aligned, scrolls on overflow. */
function AskTable({ columns, rows }: { columns: string[]; rows: Array<Array<string | number>> }) {
  return (
    <div style={{ overflowX: 'auto', maxHeight: 340, overflowY: 'auto', marginTop: 4 }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 520 }}>
        <thead>
          <tr>
            {columns.map((col, ci) => (
              <th
                key={col}
                style={{
                  textAlign: ci === 0 ? 'left' : typeof rows[0]?.[ci] === 'number' ? 'right' : 'left',
                  padding: '6px 10px',
                  fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  color: 'var(--fg-dim)',
                  fontWeight: 500,
                  borderBottom: '1px solid var(--border)',
                  background: 'var(--bg-sunken)',
                  whiteSpace: 'nowrap',
                  position: 'sticky',
                  top: 0,
                }}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className={typeof cell === 'number' ? 'tabular' : undefined}
                  style={{
                    padding: '6px 10px',
                    fontSize: 12,
                    textAlign: typeof cell === 'number' ? 'right' : 'left',
                    borderBottom: '1px solid var(--border-faint)',
                    color: ci === 0 ? 'var(--fg)' : 'var(--fg-muted)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {typeof cell === 'number' ? fmtN(cell) : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Resolved-intent chips + model attribution + optional action. */
function AskFooter({ chips, action }: { chips: string[]; action?: React.ReactNode }) {
  return (
    <Row justify="space-between" align="center" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
      <Row gap={4} align="center" style={{ flexWrap: 'wrap' }}>
        {chips.map((chip, i) => (
          <span
            key={`${chip}-${i}`}
            style={{
              padding: '1px 7px',
              borderRadius: 999,
              fontSize: 9.5,
              fontFamily: 'var(--font-mono)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              background: 'var(--bg-sunken)',
              border: '1px solid var(--border-faint)',
              color: 'var(--fg-dim)',
              whiteSpace: 'nowrap',
            }}
          >
            {chip}
          </span>
        ))}
        <span style={{ fontSize: 9.5, color: 'var(--fg-dim)', marginLeft: 4 }}>✦ Ask</span>
      </Row>
      {action}
    </Row>
  );
}
