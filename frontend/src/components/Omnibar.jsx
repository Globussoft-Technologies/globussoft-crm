import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Search,
  User,
  Briefcase,
  FileText,
  X,
  LayoutDashboard,
  Ticket,
  CheckSquare,
  FolderKanban,
  FileSpreadsheet,
  Mail,
  BookOpen,
  CornerDownLeft,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { fetchApi } from '../utils/api';
import { SEARCH_DEBOUNCE_MS } from '../utils/timing';
import { formatMoney } from '../utils/money';

// Inline top-bar global search.
//
// Pre-refactor this was a Cmd/Ctrl+K modal overlay that searched three
// entities (contacts/deals/invoices). UX feedback: the modal was
// discovery-hostile (users didn't know it existed), the placeholder
// implied a strict allow-list of three things, and the backend already
// returned seven more result types (tickets/tasks/projects/contracts/
// estimates/emails/kb) that were silently dropped on the floor.
//
// New shape:
//   - Always-visible inline input in the app header.
//   - Drop-down panel below the input shows results when query length >= 2.
//   - "Pages" section searches the user's accessible sidebar pages
//     client-side (from /api/pages/me), so users can jump to any page they
//     have permission for by typing its name or part of its description.
//     This makes the search bar the canonical SPA navigator for tenants
//     with 50+ sidebar items.
//   - Then all 10 backend result types render under their own headers.
//   - Click a row → navigate via react-router (no full page reload).
//   - Ctrl/Cmd+K focuses the input (kept for power users).
//   - Escape clears + blurs.
//   - `omnibar:open` window event still focuses the input (back-compat
//     for any legacy caller).

const ENTITY_SECTIONS = [
  // Each section: results key on the API response, plural label rendered as
  // section header, icon, an accent colour for the icon chip, and a
  // (row, navigate) renderer that turns one row into JSX + handles its
  // click navigation. Keeping all section config in one table means a new
  // backend result type only needs one entry here to surface.
  {
    key: 'pages',
    label: 'Pages',
    icon: LayoutDashboard,
    color: '#a855f7',
    bg: 'rgba(168, 85, 247, 0.12)',
    border: 'rgba(168, 85, 247, 0.25)',
    render: (p) => ({
      primary: p.label,
      secondary: p.description || p.category || p.path,
      to: p.path,
    }),
  },
  {
    key: 'contacts',
    label: 'Contacts',
    icon: User,
    color: '#3b82f6',
    bg: 'rgba(59, 130, 246, 0.12)',
    border: 'rgba(59, 130, 246, 0.25)',
    render: (c) => ({
      primary: c.company ? `${c.name} • ${c.company}` : c.name,
      secondary: c.email,
      to: `/contacts/${c.id}`,
    }),
  },
  {
    key: 'deals',
    label: 'Pipeline',
    icon: Briefcase,
    color: '#10b981',
    bg: 'rgba(16, 185, 129, 0.12)',
    border: 'rgba(16, 185, 129, 0.25)',
    render: (d) => ({
      primary: d.title,
      secondary: `Stage: ${d.stage} • ${formatMoney(d.amount, { currency: d.currency, maximumFractionDigits: 0 })}`,
      to: '/pipeline',
    }),
  },
  {
    key: 'invoices',
    label: 'Invoices',
    icon: FileText,
    color: '#f59e0b',
    bg: 'rgba(245, 158, 11, 0.12)',
    border: 'rgba(245, 158, 11, 0.25)',
    render: (i) => ({
      primary: i.invoiceNum,
      secondary: `${i.contact?.name || 'Unknown'} • ${formatMoney(i.amount, { maximumFractionDigits: 2 })}`,
      badge: i.status,
      badgeOk: i.status === 'PAID',
      to: '/invoices',
    }),
  },
  {
    key: 'tickets',
    label: 'Tickets',
    icon: Ticket,
    color: '#ef4444',
    bg: 'rgba(239, 68, 68, 0.12)',
    border: 'rgba(239, 68, 68, 0.25)',
    render: (t) => ({
      primary: t.subject,
      secondary: `${t.status || ''}${t.priority ? ` • ${t.priority}` : ''}`,
      to: '/tickets',
    }),
  },
  {
    key: 'tasks',
    label: 'Tasks',
    icon: CheckSquare,
    color: '#06b6d4',
    bg: 'rgba(6, 182, 212, 0.12)',
    border: 'rgba(6, 182, 212, 0.25)',
    render: (t) => ({
      primary: t.title,
      secondary: `${t.status || ''}${t.priority ? ` • ${t.priority}` : ''}`,
      to: '/tasks',
    }),
  },
  {
    key: 'projects',
    label: 'Projects',
    icon: FolderKanban,
    color: '#8b5cf6',
    bg: 'rgba(139, 92, 246, 0.12)',
    border: 'rgba(139, 92, 246, 0.25)',
    render: (p) => ({
      primary: p.name,
      secondary: p.status || '',
      to: '/projects',
    }),
  },
  {
    key: 'contracts',
    label: 'Contracts',
    icon: FileText,
    color: '#0ea5e9',
    bg: 'rgba(14, 165, 233, 0.12)',
    border: 'rgba(14, 165, 233, 0.25)',
    render: (c) => ({
      primary: c.title,
      secondary: c.status || '',
      to: '/contracts',
    }),
  },
  {
    key: 'estimates',
    label: 'Estimates',
    icon: FileSpreadsheet,
    color: '#84cc16',
    bg: 'rgba(132, 204, 22, 0.12)',
    border: 'rgba(132, 204, 22, 0.25)',
    render: (e) => ({
      primary: e.estimateNum ? `${e.estimateNum} — ${e.title || ''}` : e.title,
      secondary: e.status || '',
      to: '/estimates',
    }),
  },
  {
    key: 'emails',
    label: 'Email',
    icon: Mail,
    color: '#f43f5e',
    bg: 'rgba(244, 63, 94, 0.12)',
    border: 'rgba(244, 63, 94, 0.25)',
    render: (m) => ({
      primary: m.subject || '(no subject)',
      secondary: `${m.direction || ''} • ${m.from || ''} → ${m.to || ''}`.trim(),
      to: '/inbox',
    }),
  },
  {
    key: 'kbArticles',
    label: 'Knowledge Base',
    icon: BookOpen,
    color: '#14b8a6',
    bg: 'rgba(20, 184, 166, 0.12)',
    border: 'rgba(20, 184, 166, 0.25)',
    render: (a) => ({
      primary: a.title,
      secondary: a.isPublished ? 'Published' : 'Draft',
      to: '/knowledge-base',
    }),
  },
];

// Case-insensitive substring scorer for the client-side page filter.
// Returns -1 when there's no match so callers can drop the row.
function scorePageMatch(page, q) {
  if (!page || !q) return -1;
  const needle = q.toLowerCase();
  const fields = [page.label, page.description, page.category, page.path];
  let best = -1;
  for (const f of fields) {
    if (!f) continue;
    const idx = f.toLowerCase().indexOf(needle);
    if (idx === -1) continue;
    // Earlier match in label > later match in description.
    const fieldWeight = f === page.label ? 0 : f === page.description ? 100 : 200;
    const candidate = fieldWeight + idx;
    if (best === -1 || candidate < best) best = candidate;
  }
  return best;
}

export default function Omnibar() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState({});
  const [isLoading, setIsLoading] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [pagesIndex, setPagesIndex] = useState([]);

  const inputRef = useRef(null);
  const containerRef = useRef(null);
  const navigate = useNavigate();

  // Pull the user's accessible pages once so the "Pages" section can match
  // sidebar items locally — no server round-trip per keystroke. The same
  // endpoint feeds the wellness sidebar, so the cache is shared.
  useEffect(() => {
    let cancelled = false;
    fetchApi('/api/pages/me', { silent: true })
      .then((res) => {
        if (cancelled) return;
        setPagesIndex(Array.isArray(res?.pages) ? res.pages : []);
      })
      .catch(() => {
        if (cancelled) return;
        setPagesIndex([]);
      });
    const onInvalidate = () => {
      fetchApi('/api/pages/me', { silent: true })
        .then((res) => setPagesIndex(Array.isArray(res?.pages) ? res.pages : []))
        .catch(() => {});
    };
    window.addEventListener('sidebar:pages-changed', onInvalidate);
    return () => {
      cancelled = true;
      window.removeEventListener('sidebar:pages-changed', onInvalidate);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ctrl/Cmd+K focuses the inline input. No more open/close toggle —
      // the input is always in the DOM, so the shortcut becomes a
      // "jump to search" affordance.
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select?.();
      }
      if (e.key === 'Escape') {
        if (document.activeElement === inputRef.current || query) {
          setQuery('');
          setIsFocused(false);
          inputRef.current?.blur();
        }
      }
    };

    // #851 — let other components (e.g. the legacy header magnifier icon)
    // focus the search input via a custom event. Kept for back-compat with
    // callers that haven't migrated.
    const handleExternalOpen = () => {
      inputRef.current?.focus();
      inputRef.current?.select?.();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('omnibar:open', handleExternalOpen);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('omnibar:open', handleExternalOpen);
    };
  }, [query]);

  // Close dropdown on outside click. Doesn't blur the input — users can
  // re-focus and resume the same query without retyping.
  useEffect(() => {
    const onPointerDown = (e) => {
      if (!containerRef.current) return;
      if (containerRef.current.contains(e.target)) return;
      setIsFocused(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  // Server-backed search debounced behind SEARCH_DEBOUNCE_MS. Page matches
  // are client-side and update synchronously on every keystroke (so the
  // user sees their sidebar results without waiting on the network).
  useEffect(() => {
    const fetchOmni = async () => {
      if (query.length < 2) {
        setResults({});
        return;
      }
      setIsLoading(true);
      try {
        const data = await fetchApi(`/api/search?q=${encodeURIComponent(query)}`);
        setResults(data || {});
      } catch (err) {
        console.error(err);
      }
      setIsLoading(false);
    };
    const debounce = setTimeout(fetchOmni, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(debounce);
  }, [query]);

  // Client-side page match. The catalog is small (~70 entries) so a linear
  // scan + sort per keystroke is cheap.
  const pageMatches = useMemo(() => {
    if (query.length < 2 || !Array.isArray(pagesIndex)) return [];
    const scored = [];
    for (const p of pagesIndex) {
      const score = scorePageMatch(p, query);
      if (score >= 0) scored.push({ page: p, score });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, 8).map((s) => s.page);
  }, [query, pagesIndex]);

  // Merge pages (client) + backend results into a single resultSet that the
  // section table iterates over.
  const resultSet = useMemo(() => ({ pages: pageMatches, ...results }), [pageMatches, results]);

  const totalResultCount = useMemo(() => {
    return ENTITY_SECTIONS.reduce((sum, s) => sum + (resultSet[s.key]?.length || 0), 0);
  }, [resultSet]);

  const handleRowClick = useCallback(
    (to) => {
      if (to) navigate(to);
      setQuery('');
      setIsFocused(false);
      inputRef.current?.blur();
    },
    [navigate],
  );

  const showDropdown = isFocused && query.length >= 2;

  return (
    <div
      ref={containerRef}
      data-testid="omnibar-root"
      style={{
        position: 'relative',
        // Left-aligned, fixed-but-comfortable width. Earlier shape was
        // `flex: 1 1 540px` which stretched the bar across all free
        // header space, visually centering it between the hamburger and
        // the right-side controls. Switched to a bounded width + margin-
        // right: auto so the bar sits at the start of the header and
        // the right-side controls (chip / bell / profile / theme /
        // logout) keep their natural flex-end alignment.
        width: 'min(420px, 38vw)',
        minWidth: 220,
        marginRight: 'auto',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          // Use the theme's neutral subtle-bg directly. The earlier
          // var(--input-bg, …) chain inherited the generic dark theme's
          // slate-blue tint on wellness (which has no --input-bg override),
          // making the bar read as off-brand blue against the wellness
          // cream/teal palette. --subtle-bg is already theme-tinted in
          // both verticals.
          background: 'var(--subtle-bg)',
          border: `1px solid ${isFocused ? 'var(--accent-color)' : 'var(--border-color)'}`,
          borderRadius: 10,
          padding: '6px 10px',
          height: 36,
          transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
          boxShadow: isFocused ? '0 0 0 3px var(--accent-glow, rgba(99,102,241,0.18))' : 'none',
        }}
      >
        <Search size={16} color="var(--text-secondary)" style={{ flexShrink: 0 }} />
        <input
          ref={inputRef}
          type="text"
          // The wellness theme injects a global `input:focus` rule
          // (border + box-shadow with `!important`) that overrides inline
          // styles and renders a rectangular teal focus ring INSIDE this
          // search bar. `naked-input` is the documented opt-out (see
          // theme/wellness.css:213) for icon-prefixed inputs where the
          // wrapper already owns the focus chrome.
          className="naked-input"
          placeholder="Search pages, contacts, deals, invoices, tickets…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsFocused(true);
          }}
          onFocus={() => setIsFocused(true)}
          aria-label="Global search"
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            color: 'var(--text-primary)',
            fontSize: '0.9rem',
            padding: 0,
            outline: 'none',
            minWidth: 0,
          }}
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              padding: 2,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {showDropdown && (
        <div
          role="listbox"
          aria-label="Search results"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            right: 0,
            zIndex: 999,
            background: 'var(--surface-color)',
            border: '1px solid var(--border-color)',
            borderRadius: 12,
            boxShadow: 'var(--shadow-lg, 0 25px 50px -12px rgba(0,0,0,0.5))',
            backdropFilter: 'blur(12px)',
            maxHeight: '70vh',
            overflowY: 'auto',
          }}
        >
          {isLoading && totalResultCount === 0 && (
            <div
              style={{
                padding: '1.5rem 1.25rem',
                textAlign: 'center',
                color: 'var(--text-secondary)',
                fontSize: '0.85rem',
              }}
            >
              Searching…
            </div>
          )}

          {!isLoading && totalResultCount === 0 && (
            <div
              style={{
                padding: '2rem 1.25rem',
                textAlign: 'center',
                color: 'var(--text-secondary)',
                fontSize: '0.875rem',
              }}
            >
              No algorithmic matches located for "
              <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{query}</span>
              " within the enterprise dataset.
            </div>
          )}

          {totalResultCount > 0 && (
            <div style={{ padding: '0.4rem' }}>
              {ENTITY_SECTIONS.map((section) => {
                const rows = resultSet[section.key] || [];
                if (rows.length === 0) return null;
                const Icon = section.icon;
                return (
                  <div key={section.key} style={{ marginBottom: '0.25rem' }}>
                    <h4
                      style={{
                        fontSize: '0.7rem',
                        textTransform: 'uppercase',
                        letterSpacing: '0.08em',
                        color: 'var(--text-secondary)',
                        padding: '0.5rem 0.75rem 0.25rem',
                        margin: 0,
                        fontWeight: 700,
                      }}
                    >
                      {section.label}
                    </h4>
                    {rows.map((row, idx) => {
                      const r = section.render(row);
                      return (
                        <button
                          key={`${section.key}-${row.id ?? row.path ?? idx}`}
                          type="button"
                          onClick={() => handleRowClick(r.to)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.75rem',
                            padding: '0.5rem 0.75rem',
                            width: '100%',
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                            borderRadius: 8,
                            textAlign: 'left',
                            transition: 'background 0.12s ease',
                            color: 'var(--text-primary)',
                          }}
                          onMouseOver={(e) => {
                            e.currentTarget.style.background = 'var(--hover-bg, var(--subtle-bg))';
                          }}
                          onMouseOut={(e) => {
                            e.currentTarget.style.background = 'transparent';
                          }}
                        >
                          <div
                            style={{
                              background: section.bg,
                              padding: 7,
                              borderRadius: 8,
                              border: `1px solid ${section.border}`,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                            }}
                          >
                            <Icon size={16} color={section.color} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                fontWeight: 500,
                                fontSize: '0.9rem',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {r.primary}
                              {r.badge && (
                                <span
                                  style={{
                                    fontSize: '0.65rem',
                                    padding: '0.1rem 0.4rem',
                                    borderRadius: 4,
                                    background: r.badgeOk
                                      ? 'rgba(16, 185, 129, 0.18)'
                                      : 'rgba(239, 68, 68, 0.18)',
                                    color: r.badgeOk ? '#10b981' : '#ef4444',
                                    marginLeft: '0.5rem',
                                    verticalAlign: 'middle',
                                    fontWeight: 600,
                                  }}
                                >
                                  {r.badge}
                                </span>
                              )}
                            </div>
                            {r.secondary && (
                              <div
                                style={{
                                  fontSize: '0.78rem',
                                  color: 'var(--text-secondary)',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                  marginTop: 2,
                                }}
                              >
                                {r.secondary}
                              </div>
                            )}
                          </div>
                          <CornerDownLeft
                            size={12}
                            color="var(--text-secondary)"
                            style={{ opacity: 0.5, flexShrink: 0 }}
                          />
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}

          <div
            style={{
              padding: '0.5rem 0.9rem',
              borderTop: '1px solid var(--border-color)',
              fontSize: '0.7rem',
              color: 'var(--text-secondary)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>
              Press{' '}
              <kbd
                style={{
                  padding: '0.1rem 0.35rem',
                  border: '1px solid var(--border-color)',
                  borderRadius: 4,
                  background: 'var(--kbd-bg, var(--subtle-bg-3))',
                  fontFamily: 'inherit',
                }}
              >
                Esc
              </kbd>{' '}
              to close
            </span>
            <span style={{ opacity: 0.6 }}>Federated Multi-Index Search Matrix</span>
          </div>
        </div>
      )}
    </div>
  );
}
