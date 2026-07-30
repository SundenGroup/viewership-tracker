/**
 * Breadcrumbs — the drill trail for deep pages.
 *
 * Discover goes four levels deep (tracker → channel → session); a single
 * "back" link loses where you are. Every segment except the last is a
 * real link. Feed it display names, never slugs.
 */
import { Link } from 'react-router-dom';
import { Row } from './Layout';

export interface Crumb {
  label: string;
  to?: string;
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <Row gap={7} align="center" wrap style={{ fontSize: 12 }}>
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <Row key={`${c.label}-${i}`} gap={7} align="center">
              {i > 0 && <span style={{ color: 'var(--fg-faint)' }}>/</span>}
              {c.to && !last ? (
                <Link to={c.to} style={{ color: 'var(--fg-muted)', textDecoration: 'none' }}>
                  {c.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? 'page' : undefined}
                  style={{ color: last ? 'var(--fg)' : 'var(--fg-muted)', fontWeight: last ? 600 : 400 }}
                >
                  {c.label}
                </span>
              )}
            </Row>
          );
        })}
      </Row>
    </nav>
  );
}
