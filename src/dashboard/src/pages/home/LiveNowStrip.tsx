/**
 * LiveNowStrip — the StartPage hero. Surfaces series that have a broadcast
 * day live right now, with current total CCV ticking, and one-click jumps to
 * the editor and the public page.
 *
 * Degrades gracefully: hidden entirely if the backend lacks /series/live-now
 * (older deploys) or nothing is live.
 */

import { useEffect, useState } from 'react';
import { useNavigate , Link } from 'react-router-dom';
import { Row, Col, PublicLinkButton, IconBolt } from '@/components/design';
import { fmtCompact } from '@/design/format';
import * as api from '@/services/api';

export function LiveNowStrip({ canEdit }: { canEdit: boolean }) {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<api.LiveNowEntry[] | null>(null);
  const [failed, setFailed] = useState<boolean | 'error'>(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .getLiveNow()
        .then((r) => {
          if (cancelled) return;
          setEntries(r);
          setFailed(false);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          // 404 = endpoint doesn't exist on this backend — hide quietly.
          // Anything else is an incident: say the status is unavailable
          // rather than silently omitting live events.
          const notFound = err instanceof Error && err.message.startsWith('404');
          setFailed(notFound ? true : 'error');
        });
    load();
    const h = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(h);
    };
  }, []);

  if (failed === true) return null; // old backend — hide rather than error
  if (failed === 'error') {
    return (
      <div style={{ fontSize: 12.5, color: 'var(--warn)', marginBottom: 20 }}>
        Live status unavailable right now.
      </div>
    );
  }
  if (!entries) return null; // first load: stay quiet
  if (entries.length === 0) {
    return (
      <div style={{ fontSize: 12.5, color: 'var(--fg-dim)', marginBottom: 20 }}>
        Nothing live right now — <Link to="/discover" style={{ color: 'var(--red)' }}>see who's streaming your games</Link>.
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 24 }}>
      <Row gap={7} align="center" style={{ marginBottom: 10 }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: 'var(--live)',
            boxShadow: '0 0 6px var(--live)',
          }}
        />
        <span className="eyebrow" style={{ fontSize: 10.5, letterSpacing: 0.6, color: 'var(--live)' }}>
          LIVE NOW
        </span>
      </Row>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: 12,
        }}
      >
        {entries.map((e) => (
          <LiveCard key={e.series.id} entry={e} canEdit={canEdit} onOpen={() => navigate(`/${e.series.id}`)} />
        ))}
      </div>
    </div>
  );
}

function LiveCard({
  entry,
  canEdit,
  onOpen,
}: {
  entry: api.LiveNowEntry;
  canEdit: boolean;
  onOpen: () => void;
}) {
  const [ccv, setCcv] = useState<number | null>(null);
  const [channels, setChannels] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .getLiveCCV(entry.series.id)
        .then((r) => {
          if (cancelled) return;
          setCcv(r.totalCCV ?? 0);
          setChannels((r as { liveChannels?: number }).liveChannels ?? null);
        })
        .catch(() => {});
    load();
    const h = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(h);
    };
  }, [entry.series.id]);

  return (
    <div
      className="card"
      style={{
        padding: 16,
        borderRadius: 'var(--r-md)',
        border: '1px solid color-mix(in oklab, var(--live) 35%, var(--border))',
        background: 'var(--bg-card)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <Row justify="space-between" align="flex-start" gap={8}>
        <Col gap={2} style={{ minWidth: 0 }}>
          <div
            style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={entry.series.name}
          >
            {entry.series.name}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
            {entry.day.label}
            {entry.series.game ? ` · ${entry.series.game}` : ''}
          </div>
        </Col>
        <PublicLinkButton variant="icon" series={entry.series} canEdit={canEdit} />
      </Row>

      <Row align="flex-end" justify="space-between" gap={10}>
        <Col gap={0}>
          <div className="tabular" style={{ fontSize: 30, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1 }}>
            {ccv == null ? '—' : fmtCompact(ccv)}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--fg-dim)' }}>
            concurrent{channels != null ? ` · ${channels} channels` : ''}
          </div>
        </Col>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onOpen}
          style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}
        >
          <IconBolt size={12} /> Open
        </button>
      </Row>
    </div>
  );
}
