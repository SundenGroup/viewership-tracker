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
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { marked } from 'marked';
import * as api from '@/services/api';
import { Row, Tab } from '@/components/design';
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
    .replace(/<a href="(https?:\/\/[^"]+)">/g, '<a href="$1" target="_blank" rel="noopener noreferrer">')
    // Tables scroll inside their own wrapper — display:block on <table>
    // would destroy table semantics for screen readers.
    .replace(/<table>/g, '<div class="prose-tablewrap"><table>')
    .replace(/<\/table>/g, '</table></div>');
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

  // Scrollspy — highlight the TOC entry for the section in view.
  const [activeId, setActiveId] = useState<string | null>(null);
  const articleRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!html) return;
    const headings = articleRef.current?.querySelectorAll('h2[id]');
    if (!headings || headings.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setActiveId(e.target.id);
            break;
          }
        }
      },
      { rootMargin: '-10% 0px -75% 0px' },
    );
    headings.forEach((h) => observer.observe(h));
    return () => observer.disconnect();
  }, [html]);

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 20px 80px' }}>
      {/* Switcher styled like the app's tab bars, not like filter pills */}
      <Row
        gap={4}
        align="center"
        style={{
          borderBottom: '1px solid var(--border)',
          marginBottom: 28,
          position: 'sticky',
          top: 'var(--topnav-h)',
          background: 'var(--bg)',
          zIndex: 4,
          paddingTop: 8,
        }}
      >
        <Tab active={slug === 'user'} onClick={() => navigate('/guide')}>
          User guide
        </Tab>
        {isAdmin && (
          <Tab active={slug === 'admin'} onClick={() => navigate('/guide/admin')}>
            Admin guide
          </Tab>
        )}
        {doc?.updatedAt && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-dim)', paddingBottom: 6 }}>
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

      {!loading && !error && (
        <div className="guide-layout">
          {toc.length > 1 && (
            <nav aria-label="On this page" className="guide-toc">
              <span
                className="eyebrow"
                style={{ fontSize: 10, color: 'var(--fg-dim)', display: 'block', marginBottom: 8 }}
              >
                On this page
              </span>
              {toc.map((t) => (
                <a
                  key={t.id}
                  href={`#${t.id}`}
                  aria-current={activeId === t.id ? 'true' : undefined}
                  className={activeId === t.id ? 'guide-toc-link active' : 'guide-toc-link'}
                >
                  {t.label}
                </a>
              ))}
            </nav>
          )}
          <article
            ref={articleRef}
            className="prose"
            // eslint-disable-next-line react/no-danger -- our own repo docs via authenticated API
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      )}
    </div>
  );
}
