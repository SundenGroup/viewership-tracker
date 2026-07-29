/**
 * GuidePage — renders the User Guide (everyone) and Admin Guide (admins)
 * from the markdown the repo already versions in docs/. The backend hands
 * us raw markdown; we render it here so the guides live where people
 * actually are, not in the repo.
 *
 * Rendering notes:
 *  - `marked` output goes through two deterministic post-passes: heading
 *    ids (so the TOC and #anchors work) and link rewrites (guide→guide
 *    cross-links become app routes; links to repo-only docs degrade to
 *    plain text; external links open in a new tab).
 *  - dangerouslySetInnerHTML is acceptable here and only here: the content
 *    is our own repo's markdown served from our own authenticated API,
 *    not user input.
 */
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { marked } from 'marked';
import * as api from '@/services/api';
import { Row, RangePill } from '@/components/design';
import { Spinner } from '@/components/common/Loader';
import { useAuth } from '@/hooks/useAuth';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Heading ids + link rewrites on marked's output (see module header). */
function postProcess(html: string): string {
  return html
    .replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_m, level: string, inner: string) => {
      return `<h${level} id="${slugify(inner)}">${inner}</h${level}>`;
    })
    .replace(/<a href="user-guide\.md">([\s\S]*?)<\/a>/g, '<a href="/guide">$1</a>')
    .replace(/<a href="admin-guide\.md">([\s\S]*?)<\/a>/g, '<a href="/guide/admin">$1</a>')
    // Repo-only docs (permissions.md, setup-relay-pc.md, …) aren't served
    // in-app; keep the words, drop the dead link.
    .replace(/<a href="[^"]*\.md(#[^"]*)?">([\s\S]*?)<\/a>/g, '$2')
    .replace(/<a href="(https?:\/\/[^"]+)">/g, '<a href="$1" target="_blank" rel="noopener noreferrer">');
}

interface TocEntry {
  id: string;
  label: string;
}

export function GuidePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();

  const wantsAdmin = location.pathname === '/guide/admin';
  const slug: 'user' | 'admin' = wantsAdmin && isAdmin ? 'admin' : 'user';

  const [doc, setDoc] = useState<api.DocPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Non-admins deep-linking to /guide/admin land on the user guide.
  useEffect(() => {
    if (wantsAdmin && !isAdmin) navigate('/guide', { replace: true });
  }, [wantsAdmin, isAdmin, navigate]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getDoc(slug)
      .then((d) => {
        if (!cancelled) setDoc(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the guide');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const { html, toc } = useMemo(() => {
    if (!doc) return { html: '', toc: [] as TocEntry[] };
    const rendered = postProcess(marked.parse(doc.content, { async: false }) as string);
    const entries: TocEntry[] = [];
    for (const m of rendered.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)) {
      const [, id, label] = m;
      if (id && label) entries.push({ id, label: label.replace(/<[^>]+>/g, '') });
    }
    return { html: rendered, toc: entries };
  }, [doc]);

  // Anchor jumps have to be manual: the content mounts after the fetch, so
  // the browser's native #hash scroll fires before the target exists.
  useEffect(() => {
    if (!html || !location.hash) return;
    const el = document.getElementById(location.hash.slice(1));
    if (el) el.scrollIntoView({ block: 'start' });
  }, [html, location.hash]);

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '24px 20px 80px' }}>
      <Row gap={6} align="center" wrap style={{ marginBottom: 16 }}>
        <RangePill active={slug === 'user'} onClick={() => navigate('/guide')}>
          User guide
        </RangePill>
        {isAdmin && (
          <RangePill active={slug === 'admin'} onClick={() => navigate('/guide/admin')}>
            Admin guide
          </RangePill>
        )}
        {doc?.updatedAt && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-dim)' }}>
            Updated {new Date(doc.updatedAt).toLocaleDateString()}
          </span>
        )}
      </Row>

      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
          <Spinner size="lg" />
        </div>
      )}
      {error && !loading && (
        <div style={{ fontSize: 13, color: 'var(--danger)', padding: '16px 0' }}>{error}</div>
      )}

      {!loading && !error && toc.length > 1 && (
        <nav
          aria-label="Guide contents"
          style={{
            padding: '12px 16px',
            marginBottom: 20,
            borderRadius: 10,
            border: '1px solid var(--border)',
            background: 'var(--bg-sunken)',
            fontSize: 12.5,
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px 18px',
          }}
        >
          {toc.map((t) => (
            <a key={t.id} href={`#${t.id}`} style={{ color: 'var(--fg-muted)', textDecoration: 'none' }}>
              {t.label}
            </a>
          ))}
        </nav>
      )}

      {!loading && !error && (
        // eslint-disable-next-line react/no-danger -- our own repo docs via authenticated API
        <article className="prose" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}
