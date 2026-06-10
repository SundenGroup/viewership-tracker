/**
 * QuickNavCards — discoverable entry points to the app's other surfaces,
 * so Explore and Discover aren't URL-only. Shown on the StartPage between
 * the live hero and the series grid.
 */

import { useNavigate } from 'react-router-dom';
import { Row, Col, IconGrid, IconGlobe, IconChev } from '@/components/design';

export function QuickNavCards({ canExplore }: { canExplore: boolean }) {
  const navigate = useNavigate();
  const cards: Array<{ to: string; title: string; desc: string; icon: React.ReactNode; show: boolean }> = [
    {
      to: '/explore',
      title: 'Explore',
      desc: 'Post-event analysis — peaks, averages, viewed hours and per-channel overlays over any range.',
      icon: <IconGrid size={18} />,
      show: canExplore,
    },
    {
      to: '/discover',
      title: 'Discover',
      desc: 'Live game trackers — who is streaming PUBG, GeoGuessr and more on Twitch & Kick right now.',
      icon: <IconGlobe size={18} />,
      show: true,
    },
  ];

  const visible = cards.filter((c) => c.show);
  if (visible.length === 0) return null;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${visible.length}, 1fr)`,
        gap: 12,
        marginBottom: 24,
      }}
    >
      {visible.map((c) => (
        <button
          key={c.to}
          type="button"
          onClick={() => navigate(c.to)}
          className="card"
          style={{
            textAlign: 'left',
            padding: 16,
            borderRadius: 'var(--r-md)',
            border: '1px solid var(--border)',
            background: 'var(--bg-card)',
            cursor: 'pointer',
            color: 'var(--fg)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
          onMouseOver={(e) => { e.currentTarget.style.borderColor = 'var(--border-strong)'; }}
          onMouseOut={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
        >
          <Row justify="space-between" align="center">
            <Row gap={9} align="center">
              <span style={{ color: 'var(--red)', display: 'inline-flex' }}>{c.icon}</span>
              <span style={{ fontSize: 15, fontWeight: 600 }}>{c.title}</span>
            </Row>
            <IconChev size={15} />
          </Row>
          <Col gap={0}>
            <span style={{ fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.45 }}>{c.desc}</span>
          </Col>
        </button>
      ))}
    </div>
  );
}
