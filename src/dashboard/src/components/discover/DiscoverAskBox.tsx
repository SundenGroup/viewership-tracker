/**
 * DiscoverAskBox — natural-language "Ask" for Discover tracker pages.
 *
 * Mirrors ExploreAskBox (components/editor/ExploreAskBox.tsx) with a simpler
 * contract: Discover answers are read-only, so the envelope is only ever
 *   • answer  — numbers straight from Postgres, rendered as a card of stat
 *               blocks / a compact table below the hero. An answer may carry
 *               a deepLink ("Open in Channels tab") rendered as an → Open
 *               button, plus an optional data-honesty footnote.
 *   • refusal — muted message + suggestion chips that refill the input.
 * No URL patches in v1, no ⌘K binding (plain focus only) — the box lives in
 * the header row next to the tracker search.
 *
 * State lives in `useDiscoverAsk` so the input can sit in the header while
 * results render between the hero and the tab bar — two components, one
 * brain (same pattern as Explore).
 */

import { useCallback, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Row, Col, IconSparkle, IconX } from '@/components/design';
import { fmtN } from '@/design/format';
import * as api from '@/services/api';
import { ApiError } from '@/services/api';

// ── Shared controller ─────────────────────────────────────────────────────

export interface DiscoverAskController {
  question: string;
  setQuestion: (q: string) => void;
  pending: boolean;
  error: string | null;
  answer: Extract<api.DiscoverAskEnvelope, { kind: 'answer' }> | null;
  refusal: Extract<api.DiscoverAskEnvelope, { kind: 'refusal' }> | null;
  submit: () => void;
  dismiss: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

export function useDiscoverAsk({
  slug,
  getViewState,
}: {
  slug: string;
  getViewState: () => api.DiscoverAskViewState;
}): DiscoverAskController {
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Extract<api.DiscoverAskEnvelope, { kind: 'answer' }> | null>(null);
  const [refusal, setRefusal] = useState<Extract<api.DiscoverAskEnvelope, { kind: 'refusal' }> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const dismiss = useCallback(() => {
    setAnswer(null);
    setRefusal(null);
    setError(null);
  }, []);

  const submit = useCallback(async () => {
    const q = question.trim();
    if (!q || pending || !slug) return;
    // Only ONE result at a time — a new question replaces whatever is shown.
    dismiss();
    setPending(true);
    try {
      const envelope = await api.askDiscover(slug, q, getViewState());
      if (envelope.kind === 'answer') setAnswer(envelope);
      else setRefusal(envelope);
    } catch (e) {
      if (e instanceof ApiError) {
        // Prefer the server's own message (e.g. the 502 "AI backend is
        // unavailable" explanation) over canned per-status text.
        const body = e.body as { message?: unknown } | undefined;
        const serverMessage = typeof body?.message === 'string' ? body.message : null;
        setError(
          serverMessage ??
            (e.status === 429
              ? 'Ask limit reached — try again in a little while.'
              : e.status === 501
                ? 'Ask isn’t configured on this server.'
                : e.status === 502
                  ? 'The AI backend is unavailable — simple leaderboard questions still work.'
                  : 'Ask hit a snag — try again.'),
        );
      } else {
        setError('Ask hit a snag — try again.');
      }
    } finally {
      setPending(false);
    }
  }, [question, pending, slug, getViewState, dismiss]);

  return {
    question,
    setQuestion,
    pending,
    error,
    answer,
    refusal,
    submit: () => void submit(),
    dismiss,
    inputRef,
  };
}

// ── Input (lives in the Discover header row) ──────────────────────────────

export function DiscoverAskBox({ ask }: { ask: DiscoverAskController }) {
  return (
    <div style={{ flex: 1, maxWidth: 420, minWidth: 200 }}>
      <Row
        gap={7}
        align="center"
        style={{
          padding: '7px 10px',
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
          placeholder={'Ask about this game — e.g. "top 10 turkish streamers in may"'}
          aria-label="Ask about this game"
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
      <style>{`@keyframes discoverAskDotPulse { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }`}</style>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 4,
            height: 4,
            borderRadius: '50%',
            background: 'var(--fg-muted)',
            animation: `discoverAskDotPulse 1.1s ease-in-out ${i * 0.18}s infinite`,
          }}
        />
      ))}
    </span>
  );
}

// ── Results (render between the hero and the tab bar) ─────────────────────

export function DiscoverAskResults({ ask }: { ask: DiscoverAskController }) {
  if (ask.refusal) {
    return (
      <div className="card" style={{ padding: '12px 16px', marginBottom: 20 }}>
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
    const envelope = ask.answer;
    return (
      <div className="card" style={{ padding: '14px 16px', marginBottom: 20 }}>
        <Row justify="space-between" align="center" style={{ gap: 10, marginBottom: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{envelope.headline}</span>
          <CloseButton onClick={ask.dismiss} />
        </Row>
        {envelope.blocks.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--fg-dim)' }}>
            No data matched in this range.
          </div>
        )}
        <Row gap={32} style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {envelope.blocks
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
        {envelope.blocks
          .filter((b): b is Extract<api.AskBlock, { type: 'table' }> => b.type === 'table')
          .map((b, i) => (
            <AskTable key={i} columns={b.columns} rows={b.rows} />
          ))}
        <AskFooter
          chips={envelope.resolvedIntent}
          footnote={envelope.footnote}
          action={
            envelope.deepLink ? (
              <Link
                to={envelope.deepLink.href}
                className="btn btn-xs"
                style={{ textDecoration: 'none', whiteSpace: 'nowrap' }}
              >
                → {envelope.deepLink.label}
              </Link>
            ) : undefined
          }
        />
      </div>
    );
  }

  return null;
}

// ── Card internals (mirroring ExploreAskBox) ──────────────────────────────

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

/** Resolved-intent chips + model attribution + optional footnote & action. */
function AskFooter({
  chips,
  footnote,
  action,
}: {
  chips: string[];
  footnote?: string;
  action?: React.ReactNode;
}) {
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
        {footnote && (
          <span style={{ fontSize: 9.5, color: 'var(--fg-dim)', marginLeft: 4 }}>{footnote}</span>
        )}
        <span style={{ fontSize: 9.5, color: 'var(--fg-dim)', marginLeft: 4 }}>✦ Ask</span>
      </Row>
      {action}
    </Row>
  );
}
